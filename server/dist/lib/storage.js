"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStorage = createStorage;
const node_crypto_1 = require("node:crypto");
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
async function unlinkQuiet(file) {
    try {
        await promises_1.default.unlink(file);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
}
function createStorage(config) {
    const root = config.uploadDir;
    // Reject keys that escape the upload directory.
    const resolveKey = (key) => {
        const full = node_path_1.default.resolve(root, key);
        if (!full.startsWith(root + node_path_1.default.sep))
            throw new Error('invalid storage key');
        return full;
    };
    return {
        driver: 'local',
        async put(key, data) {
            const full = resolveKey(key);
            await promises_1.default.mkdir(node_path_1.default.dirname(full), { recursive: true });
            await promises_1.default.writeFile(full, data);
        },
        get: (key) => promises_1.default.readFile(resolveKey(key)),
        delete: (key) => unlinkQuiet(resolveKey(key)),
        async stat(key) {
            try {
                const st = await promises_1.default.stat(resolveKey(key));
                return st.isFile() ? { size: st.size } : null;
            }
            catch {
                return null; // ENOENT, EACCES, invalid key ...: all mean "not usable"
            }
        },
        async check() {
            await promises_1.default.mkdir(root, { recursive: true });
            const full = resolveKey(`.healthcheck-${(0, node_crypto_1.randomBytes)(6).toString('hex')}`);
            const payload = (0, node_crypto_1.randomBytes)(8);
            await promises_1.default.writeFile(full, payload);
            try {
                const back = await promises_1.default.readFile(full);
                if (!back.equals(payload))
                    throw new Error('storage read-back mismatch');
            }
            finally {
                await unlinkQuiet(full);
            }
        },
    };
}
//# sourceMappingURL=storage.js.map