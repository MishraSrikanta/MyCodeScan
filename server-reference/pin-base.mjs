/**
 * Points a bundled test at a local server.
 *
 *   node server-reference/pin-base.mjs <bundle.mjs> <http://host:port/>
 *
 * The backend host is a compiled constant by design — there is no runtime setting, so a test
 * cannot politely ask the client to talk somewhere else. Rewriting the constant in the built
 * bundle is the least invasive way in: production code keeps no test hook, and the test
 * asserts the substitution worked before it touches anything.
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [file, base] = process.argv.slice(2)

if (!file || !base) {
  console.error('usage: pin-base.mjs <bundle> <base-url>')
  process.exit(1)
}

let source = readFileSync(file, 'utf8')
const before = source

/* Either quote style, since a bundler may re-quote the literal. */
for (const name of ['PROD_BASE', 'DEV_BASE']) {
  const pattern = new RegExp(String.raw`(${name}\s*=\s*)(["'])[^"']*\2`)
  source = source.replace(pattern, `$1"${base}"`)
}

if (source === before) {
  console.error('could not pin the base — did PROD_BASE / DEV_BASE get renamed?')
  process.exit(1)
}

writeFileSync(file, source)
console.log(`pinned to ${base}`)
