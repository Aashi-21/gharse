"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DUMMY_HASH = void 0;
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
const node_crypto_1 = require("node:crypto");
// scrypt from node:crypto — no native dependency, safe on shared hosting.
// Stored format: scrypt$N$r$p$saltB64$hashB64
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
function scrypt(password, salt, n, r, p) {
    return new Promise((resolve, reject) => {
        (0, node_crypto_1.scrypt)(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
    });
}
async function hashPassword(password) {
    const salt = (0, node_crypto_1.randomBytes)(16);
    const key = await scrypt(password, salt, N, R, P);
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt')
        return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
    return actual.length === expected.length && (0, node_crypto_1.timingSafeEqual)(actual, expected);
}
// Used to burn equal time when the email is unknown (avoids user-enumeration via timing).
exports.DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(KEYLEN).toString('base64');
//# sourceMappingURL=password.js.map