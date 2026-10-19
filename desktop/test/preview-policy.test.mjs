/**
 * Unit tests for the preview origin policy.
 *
 * Run after `node build.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isLoopbackHostname,
  isPrivateHostname,
  normalizePreviewOrigin,
} from '../dist/preview-policy.js'

test('classifies loopback and private address literals', () => {
  for (const host of [
    'localhost',
    'api.localhost',
    'printer.local',
    '127.0.0.1',
    '127.10.0.5',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
  ]) {
    assert.equal(isPrivateHostname(host), true, host)
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1']) {
    assert.equal(isPrivateHostname(host), false, host)
  }
  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('[::1]'), true)
  assert.equal(isLoopbackHostname('10.0.0.1'), false)
})

test('accepts public https origins and rejects private ones by default', () => {
  assert.equal(
    normalizePreviewOrigin('https://docs.example.com'),
    'https://docs.example.com',
  )
  assert.throws(
    () => normalizePreviewOrigin('https://127.0.0.1'),
    /private address/,
  )
  assert.throws(
    () => normalizePreviewOrigin('https://192.168.1.5'),
    /private address/,
  )
  assert.equal(
    normalizePreviewOrigin('https://192.168.1.5', { allowPrivate: true }),
    'https://192.168.1.5',
  )
})

test('http is loopback-only and requires the insecure opt-in', () => {
  assert.throws(
    () => normalizePreviewOrigin('http://127.0.0.1:8080'),
    /must use https/,
  )
  assert.equal(
    normalizePreviewOrigin('http://127.0.0.1:8080', {
      allowInsecureHttp: true,
    }),
    'http://127.0.0.1:8080',
  )
  assert.throws(
    () =>
      normalizePreviewOrigin('http://example.com', { allowInsecureHttp: true }),
    /must use https/,
  )
})

test('rejects credentials, paths and malformed URLs', () => {
  assert.throws(
    () => normalizePreviewOrigin('https://user:pass@example.com'),
    /credentials/,
  )
  assert.throws(
    () => normalizePreviewOrigin('https://example.com/path'),
    /without a path/,
  )
  assert.throws(() => normalizePreviewOrigin('not a url'), /not a URL/)
})
