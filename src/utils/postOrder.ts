import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import Logger from './logger';
import { calculateOrderSize, getTradeMultiplier } from '../config/copyStrategy';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;

// Legacy parameters (for backward compatibility in SELL logic)
const TRADE_MULTIPLIER = ENV.TRADE_MULTIPLIER;
const COPY_PERCENTAGE = ENV.COPY_PERCENTAGE;
const COPY_SIZE = COPY_STRATEGY_CONFIG.copySize;

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0; // Minimum order size in USD for BUY orders
const MIN_ORDER_SIZE_TOKENS = 1.0; // Minimum order size in tokens for SELL/MERGE orders

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) {
        return undefined;
    }

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;

        const directError = data.error;
        if (typeof directError === 'string') {
            return directError;
        }

        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') {
                return nested.error;
            }
            if (typeof nested.message === 'string') {
                return nested.message;
            }
        }

        if (typeof data.errorMsg === 'string') {
            return data.errorMsg;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }
    }

    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) {
        return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number,
    userAddress: string
) => {
    const UserActivity = getUserActivityModel(userAddress);
    //Merge strategy
    if (condition === 'merge') {
        Logger.info('正在执行合并策略...');
        if (!my_position) {
            Logger.warning('没有持仓可合并');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `持仓数量 (${remaining.toFixed(2)} 代币) 太小无法合并 - 跳过`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let retry = 0;
        let abortDueToFunds = false;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                Logger.warning('订单簿中没有买单');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            Logger.info(`最佳买单: ${maxPriceBid.size} @ $${maxPriceBid.price}`);
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            // Order args logged internally
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                Logger.orderResult(
                    true,
                    `卖出 ${order_arges.amount} 代币 @ $${order_arges.price}`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `订单被拒绝: ${errorMessage || '余额或授权不足'}`
                    );
                    Logger.warning(
                        '跳过剩余尝试。请充值或运行 `npm run check-allowance` 后重试。'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `订单失败 (尝试 ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else if (condition === 'buy') {
        //Buy strategy
        Logger.info('正在执行买入策略...');

        Logger.info(`您的余额: $${my_balance.toFixed(2)}`);
        Logger.info(`交易员买入: $${trade.usdcSize.toFixed(2)}`);

        // Get current position size for position limit checks
        const currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;

        // Use new copy strategy system
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            my_balance,
            currentPositionValue
        );

        // Log the calculation reasoning
        Logger.info(`📊 ${orderCalc.reasoning}`);

        // Check if order should be executed
        if (orderCalc.finalAmount === 0) {
            Logger.warning(`❌ 无法执行: ${orderCalc.reasoning}`);
            if (orderCalc.belowMinimum) {
                Logger.warning(`💡 请增加 COPY_SIZE 或等待更大的交易`);
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let remaining = orderCalc.finalAmount;

        let retry = 0;
        let abortDueToFunds = false;
        let totalBoughtTokens = 0; // Track total tokens bought for this trade

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks || orderBook.asks.length === 0) {
                Logger.warning('订单簿中没有卖单');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);

            Logger.info(`最佳卖单: ${minPriceAsk.size} @ $${minPriceAsk.price}`);

            // MAX PRICE CHECK
            const MAX_PRICE = 0.99; // Safety limit
            if (parseFloat(minPriceAsk.price) > MAX_PRICE) {
                Logger.warning(
                    `价格 $${minPriceAsk.price} 高于最大限制 $${MAX_PRICE} - 跳过`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            // SLIPPAGE CHECK & LIMIT ORDER FALLBACK
            if (parseFloat(minPriceAsk.price) - 0.05 > trade.price) {
                Logger.warning(
                    `滑点过高 (>0.05) - 正在以交易员价格 ($${trade.price}) 挂限价单`
                );

                const limitPrice = trade.price;
                const tokenSize = remaining / limitPrice;

                if (tokenSize < MIN_ORDER_SIZE_TOKENS) {
                    Logger.warning(
                        `计算出的代币数量 ${tokenSize.toFixed(2)} < 最小数量 ${MIN_ORDER_SIZE_TOKENS} - 跳过`
                    );
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    break;
                }

                try {
                    const limitOrderArgs = {
                        side: Side.BUY,
                        tokenID: trade.asset,
                        size: tokenSize,
                        price: limitPrice,
                    };

                    Logger.info(
                        `创建限价单: ${tokenSize.toFixed(2)} 代币 @ $${limitPrice}`
                    );
                    const signedOrder = await clobClient.createOrder(limitOrderArgs);
                    const resp = await clobClient.postOrder(signedOrder, OrderType.GTC);

                    if (resp.success) {
                        Logger.success(`限价单下单成功: ${resp.orderID}`);
                        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                        remaining = 0; // Stop the loop
                    } else {
                        const errorMessage = extractOrderError(resp);
                        Logger.error(`限价单失败: ${errorMessage}`);
                        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    }
                } catch (error) {
                    Logger.error(`限价单下单错误: ${error}`);
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                }
                break;
            }

            const buyPrice = parseFloat(minPriceAsk.price);
            // Buy amount in USDC
            let buyAmount = Math.min(remaining, parseFloat(minPriceAsk.size) * buyPrice);

            // Check if order size is too small
            if (buyAmount < MIN_ORDER_SIZE_USD) {
                Logger.info(
                    `订单金额 $${buyAmount.toFixed(2)} 小于最小限制 $${MIN_ORDER_SIZE_USD} - 跳过此卖单`
                );
                // If we can't fill even the minimum, we might be stuck. 
                // But usually we just take the next ask? 
                // Actually, if the best ask is too small, we might want to skip it and try the next one?
                // But we are reducing from orderBook.asks[0].
                // Let's just continue to try to fill.
                // Wait, if we 'continue', we might loop forever if we don't remove this ask or move on.
                // But we are re-fetching orderbook every loop.
                // So if we don't fill, we might hit the same ask again.
                // For safety, let's break if we can't fill anything meaningful.
                break;
            }

            // Calculate token size
            let size = buyAmount / buyPrice;

            // Fix for precision issues: if the resulting value is very close to MIN_ORDER_SIZE_USD, 
            // add a small buffer to ensure it doesn't fall below $1 due to rounding.
            if (size * buyPrice < MIN_ORDER_SIZE_USD * 1.05) {
                const safeMinSize = MIN_ORDER_SIZE_USD * 1.01; // Target $1.01 to be safe
                size = safeMinSize / buyPrice;
                buyAmount = size * buyPrice; // Update buyAmount for logging
                Logger.info(`Adjusting order size to $${buyAmount.toFixed(4)} to ensure minimum $1 requirement`);
            }

            Logger.info(
                `正在创建订单: $${buyAmount.toFixed(2)} @ $${buyPrice} (余额: $${my_balance.toFixed(2)})`
            );

            try {
                const orderArgs = {
                    side: Side.BUY,
                    tokenID: trade.asset,
                    size: size,
                    price: buyPrice,
                };

                const signedOrder = await clobClient.createOrder(orderArgs);
                const resp = await clobClient.postOrder(signedOrder);

                if (resp.success) {
                    Logger.success(
                        `订单执行成功: 买入 $${buyAmount.toFixed(2)} @ $${buyPrice} (${size.toFixed(2)} 代币)`
                    );
                    remaining -= buyAmount;
                    totalBoughtTokens += size;

                    // Update user activity
                    await UserActivity.updateOne(
                        { _id: trade._id },
                        {
                            $set: {
                                bot: true,
                                botExcutedTime: Date.now(),
                            },
                            $inc: {
                                myBoughtSize: size,
                                myBoughtUsdc: buyAmount,
                            },
                        }
                    );
                } else {
                    const errorMessage = extractOrderError(resp);
                    Logger.error(`订单失败: ${errorMessage}`);

                    // Check for insufficient balance/allowance
                    if (
                        errorMessage && (
                            errorMessage.includes('Not enough collateral') ||
                            errorMessage.includes('Not enough allowance')
                        )
                    ) {
                        abortDueToFunds = true;
                        Logger.warning(
                            `订单被拒绝: ${errorMessage || '余额或授权不足'}`
                        );
                        Logger.warning(
                            '跳过剩余尝试。请充值或运行 `npm run check-allowance` 后重试。'
                        );
                        break;
                    }
                    retry += 1;
                    Logger.warning(
                        `订单失败 (尝试 ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                    );
                }
            } catch (error) {
                Logger.error(`下单错误: ${error}`);
                retry += 1;
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT, myBoughtSize: totalBoughtTokens }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: retry, myBoughtSize: totalBoughtTokens }
            );
        } else {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, myBoughtSize: totalBoughtTokens }
            );
        }

        // Log the tracked purchase for later sell reference
        if (totalBoughtTokens > 0) {
            Logger.info(
                `📝 记录买入: ${totalBoughtTokens.toFixed(2)} 代币用于后续卖出计算`
            );
        }
    } else if (condition === 'sell') {
        //Sell strategy
        Logger.info('正在执行卖出策略...');
        let remaining = 0;
        if (!my_position) {
            Logger.warning('没有持仓可卖');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Get all previous BUY trades for this asset to calculate total bought
        const previousBuys = await UserActivity.find({
            asset: trade.asset,
            conditionId: trade.conditionId,
            side: 'BUY',
            bot: true,
            myBoughtSize: { $exists: true, $gt: 0 },
        }).exec();

        const totalBoughtTokens = previousBuys.reduce(
            (sum, buy) => sum + (buy.myBoughtSize || 0),
            0
        );

        if (totalBoughtTokens > 0) {
            Logger.info(
                `📊 找到 ${previousBuys.length} 条之前的买入记录: 共买入 ${totalBoughtTokens.toFixed(2)} 代币`
            );
        }

        if (!user_position) {
            // Trader sold entire position - we sell entire position too
            remaining = my_position.size;
            Logger.info(
                `交易员清空了仓位 → 卖出您所有的 ${remaining.toFixed(2)} 代币`
            );
        } else {
            // Calculate the % of position the trader is selling
            const trader_sell_percent = trade.size / (user_position.size + trade.size);
            const trader_position_before = user_position.size + trade.size;

            Logger.info(
                `仓位对比: 交易员有 ${trader_position_before.toFixed(2)} 代币, 您有 ${my_position.size.toFixed(2)} 代币`
            );
            Logger.info(
                `交易员卖出: ${trade.size.toFixed(2)} 代币 (占其仓位的 ${(trader_sell_percent * 100).toFixed(2)}%)`
            );

            // Use tracked bought tokens if available, otherwise fallback to current position
            let baseSellSize;
            if (totalBoughtTokens > 0) {
                baseSellSize = totalBoughtTokens * trader_sell_percent;
                Logger.info(
                    `根据追踪的买入记录计算: ${totalBoughtTokens.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} 代币`
                );
            } else {
                baseSellSize = my_position.size * trader_sell_percent;
                Logger.warning(
                    `未找到追踪的买入记录，使用当前持仓计算: ${my_position.size.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} 代币`
                );
            }

            // Apply tiered or single multiplier based on trader's order size (symmetrical with BUY logic)
            const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
            remaining = baseSellSize * multiplier;

            if (multiplier !== 1.0) {
                Logger.info(
                    `应用 ${multiplier}x 倍率 (基于交易员 $${trade.usdcSize.toFixed(2)} 订单): ${baseSellSize.toFixed(2)} → ${remaining.toFixed(2)} 代币`
                );
            }
        }

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `❌ 无法执行: 卖出数量 ${remaining.toFixed(2)} 代币低于最小限制 (${MIN_ORDER_SIZE_TOKENS} 代币)`
            );
            Logger.warning(`💡 这通常发生在仓位太小或不匹配时`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        // Cap sell amount to available position size
        if (remaining > my_position.size) {
            Logger.warning(
                `⚠️  计算出的卖出量 ${remaining.toFixed(2)} 代币 > 您的持仓 ${my_position.size.toFixed(2)} 代币`
            );
            Logger.warning(`限制为最大可用量: ${my_position.size.toFixed(2)} 代币`);
            remaining = my_position.size;
        }

        let retry = 0;
        let abortDueToFunds = false;
        let totalSoldTokens = 0; // Track total tokens sold

        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                Logger.warning('订单簿中没有买单');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            Logger.info(`最佳买单: ${maxPriceBid.size} @ $${maxPriceBid.price}`);

            // Check if remaining amount is below minimum before creating order
            if (remaining < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `剩余数量 (${remaining.toFixed(2)} 代币) 低于最小限制 - 完成交易`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const sellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));

            // Final check: don't create orders below minimum
            if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `订单数量 (${sellAmount.toFixed(2)} 代币) 低于最小限制 - 完成交易`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const order_arges = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sellAmount,
                price: parseFloat(maxPriceBid.price),
            };
            // Order args logged internally
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                totalSoldTokens += order_arges.amount;
                Logger.orderResult(
                    true,
                    `卖出 ${order_arges.amount} 代币 @ $${order_arges.price}`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `订单被拒绝: ${errorMessage || '余额或授权不足'}`
                    );
                    Logger.warning(
                        '跳过剩余尝试。请充值或运行 `npm run check-allowance` 后重试。'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `订单失败 (尝试 ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }

        // Update tracked purchases after successful sell
        if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
            const sellPercentage = totalSoldTokens / totalBoughtTokens;

            if (sellPercentage >= 0.99) {
                // Sold essentially all tracked tokens - clear tracking
                await UserActivity.updateMany(
                    {
                        asset: trade.asset,
                        conditionId: trade.conditionId,
                        side: 'BUY',
                        bot: true,
                        myBoughtSize: { $exists: true, $gt: 0 },
                    },
                    { $set: { myBoughtSize: 0 } }
                );
                Logger.info(
                    `🧹 已清除买入追踪 (卖出了 ${(sellPercentage * 100).toFixed(1)}% 的仓位)`
                );
            } else {
                // Partial sell - reduce tracked purchases proportionally
                for (const buy of previousBuys) {
                    const newSize = (buy.myBoughtSize || 0) * (1 - sellPercentage);
                    await UserActivity.updateOne(
                        { _id: buy._id },
                        { $set: { myBoughtSize: newSize } }
                    );
                }
                Logger.info(
                    `📝 更新买入追踪 (卖出了 ${(sellPercentage * 100).toFixed(1)}% 的追踪仓位)`
                );
            }
        }

        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT }
            );
            return;
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else {
        Logger.error(`未知交易类型: ${condition}`);
    }
};

export default postOrder;
