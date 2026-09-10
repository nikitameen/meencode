import * as electron from 'electron'

type FetchInit = RequestInit & { signal?: AbortSignal }

/**
 * Proxy-safe fetch for the Electron main process.
 *
 * Node's global fetch uses Node's bundled CA store and ignores system
 * proxies — behind corporate TLS interception (Zscaler, Netskope, ...)
 * every request fails with "unable to get local issuer certificate".
 * Electron's net.fetch goes through Chromium's network stack, which uses
 * the OS certificate store, system proxy settings and PAC files.
 *
 * Falls back to global fetch when not running inside Electron (vitest).
 */
export async function proxySafeFetch(url: string, init?: FetchInit): Promise<Response> {
  const net = (electron as { net?: { fetch?: typeof fetch } }).net
  if (typeof net?.fetch === 'function') return net.fetch(url, init)
  return fetch(url, init)
}