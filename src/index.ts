import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import test from './test/test';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        Logger.warning('正在执行关闭程序，强制退出...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`收到 ${signal} 信号，开始优雅关闭...`);

    try {
        // Stop services
        stopTradeMonitor();
        stopTradeExecutor();

        // Give services time to finish current operations
        Logger.info('等待服务完成当前操作...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close database connection
        await closeDB();

        Logger.success('优雅关闭完成');
        process.exit(0);
    } catch (error) {
        Logger.error(`关闭期间发生错误: ${error}`);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`未处理的 Promise 拒绝: ${promise}, 原因: ${reason}`);
    // Don't exit immediately, let the application try to recover
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    Logger.error(`未捕获的异常: ${error.message}`);
    // Exit immediately for uncaught exceptions as the application is in an undefined state
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export const main = async () => {
    try {
        // Welcome message for first-time users
        const colors = {
            reset: '\x1b[0m',
            yellow: '\x1b[33m',
            cyan: '\x1b[36m',
        };

        console.log(`\n${colors.yellow}💡 第一次运行机器人?${colors.reset}`);
        console.log(`   阅读指南: ${colors.cyan}GETTING_STARTED.md${colors.reset}`);
        console.log(`   运行健康检查: ${colors.cyan}npm run health-check${colors.reset}\n`);

        await connectDB();
        Logger.startup(USER_ADDRESSES, PROXY_WALLET);

        // Perform initial health check
        Logger.info('正在执行初始健康检查...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('健康检查失败，但继续启动...');
        }

        Logger.info('正在初始化 CLOB 客户端...');
        const clobClient = await createClobClient();
        Logger.success('CLOB 客户端就绪');

        Logger.separator();
        Logger.info('正在启动交易监控...');
        tradeMonitor();

        Logger.info('正在启动交易执行器...');
        tradeExecutor(clobClient);

        // test(clobClient);
    } catch (error) {
        Logger.error(`启动期间发生致命错误: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
