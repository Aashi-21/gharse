"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const app_1 = require("./app");
const config_1 = require("./config");
async function main() {
    let config;
    try {
        config = (0, config_1.loadConfig)();
    }
    catch (e) {
        if (e instanceof config_1.ConfigError) {
            console.error(e.message);
            process.exit(1);
        }
        throw e;
    }
    const app = await (0, app_1.buildApp)(config);
    const shutdown = async (signal) => {
        app.log.info(`${signal} received, shutting down`);
        await app.close();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
    // PORT comes from the environment, which is what Passenger/GoDaddy Node hosting and Docker expect.
    await app.listen({ port: config.PORT, host: config.HOST });
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map