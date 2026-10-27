import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

// Execute the real entry points with isolated auth/storage dependencies.
function loadModule(path, mocks) {
    const source = readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    })
    const exports = {}
    vm.runInNewContext(outputText, {
        exports,
        require: (name) => mocks[name] || {},
        process: { env: { NEXT_PUBLIC_APP_URL: 'https://shop.example', MERCHANT_ID: 'test', MERCHANT_KEY: 'test' } },
        URL, URLSearchParams, console,
    }, { filename: path })
    return exports
}

const forbiddenDb = new Proxy({}, {
    get() { assert.fail('Unauthenticated requests must not access the database or reserve stock') },
})
const anonymousSessions = [null, {}, { user: {} }, { user: { id: '' } }]

for (const [index, session] of anonymousSessions.entries()) {
    for (const [file, action, args] of [
        ['actions/checkout.ts', 'createOrder', ['product', 1, undefined, true]],
        ['actions/checkout.ts', 'getRetryPaymentParams', ['order']],
        ['actions/payment.ts', 'createPaymentOrder', [1]],
    ]) {
        test(`${action} rejects missing identity ${index} before any side effects`, async () => {
            const module = loadModule(file, {
                '@/lib/auth': { auth: async () => session },
                '@/lib/db': { db: forbiddenDb },
                '@/lib/crypto': { generateOrderId: () => assert.fail('Must not allocate an order') },
                'next/headers': { cookies: () => assert.fail('Must not set payment cookies') },
            })
            const result = await module[action](...args)
            assert.equal(result.success, false)
            assert.equal(result.error, 'common.loginRequired')
        })
    }
}

test('authenticated product purchases still reach product validation', async () => {
    let lookedUp = false
    const { createOrder } = loadModule('actions/checkout.ts', {
        '@/lib/auth': { auth: async () => ({ user: { id: 'user-1' } }) },
        '@/lib/db': { db: { query: { products: { findFirst: async () => { lookedUp = true; return null } } } } },
        '@/lib/db/schema': { products: { id: 'id' } },
        'drizzle-orm': { eq: () => true },
    })
    const result = await createOrder('missing-product')
    assert.equal(lookedUp, true)
    assert.equal(result.error, 'buy.productNotFound')
})

test('authenticated payment orders retain the account identity', async () => {
    const writes = []
    const { createPaymentOrder } = loadModule('actions/payment.ts', {
        '@/lib/auth': { auth: async () => ({ user: { id: 'user-1', username: 'buyer' } }) },
        '@/lib/db': { db: { insert: () => ({ values: async (value) => writes.push(value) }) } },
        '@/lib/db/queries': { withOrderColumnFallback: (fn) => fn() },
        '@/lib/admin-auth': { getAdminUsernames: () => ['merchant'] },
        '@/lib/crypto': { generateOrderId: () => 'test-order', generateSign: () => 'test-signature' },
        '@/lib/payment': { PAYMENT_PRODUCT_ID: 'payment', PAYMENT_PRODUCT_NAME: 'Payment' },
        'next/headers': { cookies: async () => ({ set() {} }) },
    })
    const result = await createPaymentOrder(1)
    assert.equal(result.success, true)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].userId, 'user-1')
    assert.equal(writes[0].username, 'buyer')
    assert.equal(writes[0].status, 'pending')
})

test('anonymous payment pages require login and preserve the payment link', async () => {
    const redirectError = new Error('redirect')
    let location
    const { default: page } = loadModule('app/pay/page.tsx', {
        '@/lib/auth': { auth: async () => null },
        'next/cache': { unstable_noStore() {} },
        'next/navigation': { redirect: (url) => { location = url; throw redirectError } },
    })
    await assert.rejects(page({ searchParams: Promise.resolve({ to: 'merchant', sig: 'signature' }) }), redirectError)
    const url = new URL(location, 'https://shop.example')
    assert.equal(url.pathname, '/login')
    assert.equal(url.searchParams.get('callbackUrl'), '/pay?to=merchant&sig=signature')
})

class NextResponse extends Response {
    static redirect(url, status = 307) { return new Response(null, { status, headers: { location: String(url) } }) }
}

test('anonymous payment forwarding rejects even direct POSTs without parsing the form', async () => {
    const { POST } = loadModule('app/paying/route.ts', {
        '@/lib/auth': { auth: async () => null },
        'next/server': { NextResponse },
    })
    const result = await POST({
        url: 'https://shop.example/paying',
        formData: () => assert.fail('Must reject before reading payment data'),
    })
    assert.equal(result.status, 303)
    assert.equal(result.headers.get('location'), 'https://shop.example/login?callbackUrl=%2Forders')
})

test('authenticated payment forwarding still submits to the gateway', async () => {
    const { POST } = loadModule('app/paying/route.ts', {
        '@/lib/auth': { auth: async () => ({ user: { id: 'user-1' } }) },
        'next/server': { NextResponse },
    })
    const form = new FormData()
    form.set('out_trade_no', 'test-order')
    const result = await POST({ url: 'https://shop.example/paying', formData: async () => form })
    assert.equal(result.status, 200)
    assert.match(await result.text(), /name="out_trade_no" value="test-order"/)
})
