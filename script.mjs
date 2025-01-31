import 'dotenv/config';
import axios from 'axios';
import { Keypair, Connection, clusterApiUrl, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { AccountLayout, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import fs from 'fs';
import bs58 from 'bs58';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import WebSocket from 'ws';

const SOLANA_WALLET_PATH = process.env.SOLANA_WALLET_PATH;
const DEVELOPER_ADDRESS = '98H34PJHrHS9AVeYWDGsej3oyV74zsc7XiA4PRZBppWF';
const SESSION_ID = process.env.SESSION_ID;

let privateKey;
try {
    const keypair = fs.readFileSync(SOLANA_WALLET_PATH, 'utf8');
    const keypairArray = JSON.parse(keypair);

    if (Array.isArray(keypairArray)) {
        privateKey = Uint8Array.from(keypairArray);
        console.log('Private key loaded from keypair file.');
    } else {
        throw new Error('Invalid keypair format');
    }
} catch (error) {
    console.error('Error reading Solana wallet keypair:', error);
    process.exit(1);
}

const payer = Keypair.fromSecretKey(privateKey);
const connection = new Connection(clusterApiUrl('mainnet-beta'));

const MINIMUM_BUY_AMOUNT = parseFloat(process.env.MINIMUM_BUY_AMOUNT || 0.015);
const MAX_BONDING_CURVE_PROGRESS = parseInt(process.env.MAX_BONDING_CURVE_PROGRESS || 10);
const SELL_BONDING_CURVE_PROGRESS = parseInt(process.env.SELL_BONDING_CURVE_PROGRESS || 15);
const PROFIT_TARGET_1 = 1.25;
const PROFIT_TARGET_2 = 1.25;
const STOP_LOSS_LIMIT = 0.90;
const MONITOR_INTERVAL = 5 * 1000;
const SELL_TIMEOUT = 2 * 60 * 1000;
const TRADE_DELAY = 90 * 1000;
const PRIORITY_FEE_BASE = 0.0003;
const API_RETRY_LIMIT = 5;
const BASE_API_DELAY = 1000;

const screen = blessed.screen();
const grid = new contrib.grid({ rows: 12, cols: 12, screen: screen });

const logBox = grid.set(3, 0, 9, 12, blessed.box, {
    fg: 'green',
    label: 'Trading Bot Log',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: {
        fg: 'green',
        ch: '|'
    }
});

const accountInfoBox = grid.set(9, 0, 2, 12, blessed.box, {
    fg: 'green',
    label: 'Account Info',
    tags: true
});

const menuBox = grid.set(11, 0, 1, 12, blessed.box, {
    fg: 'white',
    label: 'Menu',
    tags: true,
    content: 'R: Reset Timer | C: Continue | S: Sell 75%'
});

screen.render();

let resetTimer = false;
let continueTrade = false;
let sellImmediately = false;
let cooldownActive = false;

const updateLog = (message) => {
    logBox.insertBottom(message);
    logBox.setScrollPerc(100);
    screen.render();
};

const updateAccountInfo = async () => {
    const balance = await checkBalance();
    const tokenBalances = await fetchSPLTokens();

    let tokenBalancesText = '';
    tokenBalances.forEach(token => {
        if (token.amount > 1) {
            tokenBalancesText += `Mint: ${token.mint}, Amount: ${token.amount} SPL\n`;
        }
    });

    accountInfoBox.setContent(`Account address: ${payer.publicKey.toString()}\nAccount balance: ${balance} SOL\n${tokenBalancesText}`);
    screen.render();
};

const setVisualMode = (mode) => {
    if (mode === 'trading') {
        logBox.style.fg = 'yellow';
        logBox.style.border = { type: 'line', fg: 'red' };
        accountInfoBox.style.fg = 'yellow';
        accountInfoBox.style.border = { type: 'line', fg: 'red' };
    } else {
        logBox.style.fg = 'green';
        logBox.style.border = { type: 'line', fg: 'blue' };
        accountInfoBox.style.fg = 'green';
        accountInfoBox.style.border = { type: 'line', fg: 'blue' };
    }
    screen.render();
};

const sendDeveloperFee = async () => {
    try {
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: new PublicKey(DEVELOPER_ADDRESS),
                lamports: 0.05 * 1e9
            })
        );
        const signature = await sendAndConfirmTransaction(connection, transaction, [payer]);
        updateLog(`Developer fee sent with transaction signature: ${signature}`);
    } catch (error) {
        updateLog(`Error sending developer fee: ${error.message}`);
    }
};

const apiRequest = async (url, data, retries = API_RETRY_LIMIT) => {
    let attempt = 0;
    let delay = BASE_API_DELAY;

    while (attempt < retries) {
        try {
            const response = await axios.post(url, data);
            return response.data;
        } catch (error) {
            if (error.response) {
                updateLog(`API Error: ${error.response.status} - ${error.response.data}`);
                
                if (error.response.status === 429) {
                    const retryAfter = error.response.headers['retry-after'] * 1000 || delay;
                    delay = retryAfter;
                    updateLog(`Rate limited. Retrying in ${delay / 1000} seconds...`);
                }
            }

            if (++attempt >= retries) {
                throw error;
            }

            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2;
        }
    }
};

const pumpFunBuy = async (mint, amount) => {
    const url = "https://pumpapi.fun/api/trade";
    const data = {
        trade_type: "buy",
        mint,
        amount,
        slippage: 5,
        priorityFee: PRIORITY_FEE_BASE,
        userPrivateKey: bs58.encode(privateKey)
    };

    try {
        const result = await apiRequest(url, data);
        return result.tx_hash;
    } catch (error) {
        updateLog(`Buy transaction failed: ${error.message}`);
        return null;
    }
};

const pumpFunSell = async (mint, amount) => {
    const url = "https://pumpapi.fun/api/trade";
    const data = {
        trade_type: "sell",
        mint,
        amount: amount.toString(),
        slippage: 5,
        priorityFee: PRIORITY_FEE_BASE,
        userPrivateKey: bs58.encode(privateKey)
    };

    try {
        const result = await apiRequest(url, data);
        return result.tx_hash;
    } catch (error) {
        updateLog(`Sell transaction failed: ${error.message}`);
        return null;
    }
};

const checkBalance = async () => {
    const balance = await connection.getBalance(payer.publicKey);
    updateLog(`Current balance: ${balance / 1e9} SOL`);
    return balance / 1e9;
};

const fetchSPLTokens = async () => {
    try {
        const tokenAccounts = await connection.getTokenAccountsByOwner(payer.publicKey, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
        return tokenAccounts.value.map(accountInfo => {
            const accountData = AccountLayout.decode(accountInfo.account.data);
            return {
                mint: new PublicKey(accountData.mint).toString(),
                amount: Number(accountData.amount) / 10 ** 6
            };
        }).filter(token => token.amount > 1);
    } catch (error) {
        updateLog(`Error fetching SPL tokens: ${error.message}`);
        return [];
    }
};

const sellTokens = async (mint, sellPercentage) => {
    const tokens = await fetchSPLTokens();
    for (const token of tokens) {
        if (token.mint === mint) {
            const amountToSell = token.amount * sellPercentage;
            if (amountToSell >= 1) {
                updateLog(`Selling ${amountToSell} of token ${mint}`);

                let txHash = null;
                try {
                    txHash = await pumpFunSell(mint, amountToSell);
                    if (txHash) {
                        updateLog(`Sold ${amountToSell} of token ${mint} with transaction hash: ${txHash}`);
                    }
                } catch (error) {
                    updateLog(`Failed to sell token ${mint}: ${error.message}`);
                }

                return txHash;
            } else {
                updateLog(`Skipping token ${mint} as the human-readable amount is less than 1`);
            }
            break;
        }
    }
};

const monitorTrade = async (mint, initialMarketCap, initialBondingCurve) => {
    let endTime = Date.now() + SELL_TIMEOUT;
    const tradeAllowedTime = Date.now() + TRADE_DELAY;
    let lastMarketCap = initialMarketCap;

    while (Date.now() < endTime) {
        const tokenInfo = await getTokenInfoFromWebSocket(mint);
        if (tokenInfo) {
            const marketCapChange = ((tokenInfo.marketcap - initialMarketCap) / initialMarketCap) * 100;
            updateLog(`\nTicker: ${tokenInfo.ticker}`);
            updateLog(`Market Cap: $${tokenInfo.marketcap}`);
            updateLog(`Current Market Cap: $${tokenInfo.marketcap}, Change: ${marketCapChange.toFixed(2)}%`);
            updateLog(`Time remaining: ${((endTime - Date.now()) / 1000).toFixed(0)}s`);
            updateLog(`Pump.fun link: https://pump.fun/${mint}`);
            updateLog(`Current Bonding Curve: ${tokenInfo.bondingCurve}%`);

            if (marketCapChange >= 25) {
                updateLog(`Market cap increased by 25%. Selling 50% of tokens for mint: ${mint}`);
                await sellTokens(mint, 0.50);
                lastMarketCap = tokenInfo.marketcap;
                continueTrade = true;
            } else if (marketCapChange <= -10) {
                updateLog(`Market cap fell by more than 10%. Selling all tokens for mint: ${mint}`);
                await sellTokens(mint, 1.00);
                break;
            } else if (tokenInfo.bondingCurve >= SELL_BONDING_CURVE_PROGRESS) {
                updateLog(`Bonding curve reached ${SELL_BONDING_CURVE_PROGRESS}%. Selling 75% of tokens for mint: ${mint}`);
                await sellTokens(mint, 0.75);
                break;
            }

            if (tokenInfo.marketcap > lastMarketCap * PROFIT_TARGET_2) {
                updateLog('Price increased another 25%, selling 75% of remaining tokens.');
                await sellTokens(mint, 0.75);
                lastMarketCap = tokenInfo.marketcap;
            }

            if (resetTimer) {
                updateLog('Resetting timer.');
                endTime = Date.now() + SELL_TIMEOUT;
                resetTimer = false;
            }

            if (continueTrade) {
                updateLog('Continuing to the next trade.');
                continueTrade = false;
                break;
            }

            if (sellImmediately) {
                updateLog('Selling 75% immediately.');
                await sellTokens(mint, 0.75);
                sellImmediately = false;
                break;
            }
        }

        await new Promise(resolve => setTimeout(resolve, MONITOR_INTERVAL));
    }

    if (Date.now() >= endTime) {
        updateLog(`Market cap did not increase by 25% within the set time. Selling 75% of tokens for mint: ${mint}`);
        await sellTokens(mint, 0.75);
    }
};

const getTokenInfoFromWebSocket = async (mint) => {
    return new Promise((resolve) => {
        const ws = new WebSocket('wss://pumpportal.fun/api/data', {
            headers: {
                'Authorization': `Bearer ${SESSION_ID}`
            }
        });

        ws.on('open', () => {
            updateLog('WebSocket connection opened.');
            ws.send(JSON.stringify({ action: 'subscribe', mint }));
        });

        ws.on('message', (data) => {
            const message = JSON.parse(data);
            if (message.mint === mint) {
                resolve({
                    ticker: message.ticker,
                    marketcap: message.marketcap,
                    bondingCurve: message.bondingCurve
                });
                ws.close();
            }
        });

        ws.on('error', (error) => {
            updateLog(`WebSocket error: ${error.message}`);
            resolve(null);
        });

        ws.on('close', () => {
            updateLog('WebSocket connection closed.');
        });
    });
};

const simulateTrade = async () => {
    const ws = new WebSocket('wss://pumpportal.fun/api/data', {
        headers: {
            'Authorization': `Bearer ${SESSION_ID}`
        }
    });

    ws.on('open', () => {
        updateLog('WebSocket connection opened.');
        ws.send(JSON.stringify({ action: 'subscribe', channel: 'new_pairs' }));
    });

    ws.on('message', async (data) => {
        if (cooldownActive) return;
        
        const message = JSON.parse(data);
        if (message.channel === 'new_pairs') {
            cooldownActive = true;
            setTimeout(() => cooldownActive = false, 15000);

            const mint = message.mint;
            const tokenInfo = await getTokenInfoFromWebSocket(mint);
            if (tokenInfo && tokenInfo.bondingCurve < MAX_BONDING_CURVE_PROGRESS) {
                updateLog(`Found new token: ${tokenInfo.ticker} (${mint})`);
                setVisualMode('trading');
                
                const txHash = await pumpFunBuy(mint, MINIMUM_BUY_AMOUNT);
                if (txHash) {
                    await monitorTrade(mint, tokenInfo.marketcap, tokenInfo.bondingCurve);
                }
                
                setVisualMode('searching');
            }
        }
    });

    ws.on('error', (error) => {
        updateLog(`WebSocket error: ${error.message}`);
    });

    ws.on('close', () => {
        updateLog('WebSocket connection closed.');
    });
};

const main = async () => {
    updateLog('Starting live trading mode...');
    await updateAccountInfo();
    setVisualMode('searching');
    simulateTrade();
};

const liveUpdateAccountInfo = async () => {
    while (true) {
        await updateAccountInfo();
        await new Promise(resolve => setTimeout(resolve, 10000));
    }
};

screen.key(['r', 'R'], () => {
    resetTimer = true;
    updateLog('{bold}Timer reset{/bold}');
});

screen.key(['c', 'C'], () => {
    continueTrade = true;
    updateLog('{bold}Continue trading{/bold}');
});

screen.key(['s', 'S'], () => {
    sellImmediately = true;
    updateLog('{bold}Selling 75% immediately{/bold}');
});

screen.key(['escape', 'q', 'C-c'], () => {
    updateLog('{bold}Shutting down bot...{/bold}');
    process.exit(0);
});

const splashScreen = () => {
    const splash = blessed.box({
        parent: screen,
        top: 'center',
        left: 'center',
        width: '80%',
        height: '80%',
        content: `
Welcome to the Solana Trading Bot!

[Security Improvements]
- Removed insecure TLS settings
- Added proper rate limiting
- Implemented API cooldown
- Enhanced error handling

Trading Strategy:
- Buy when bonding curve < ${MAX_BONDING_CURVE_PROGRESS}%
- Sell 50% at +25% profit
- Sell 75% at next +25% profit
- Stop loss at -10% or ${SELL_BONDING_CURVE_PROGRESS}% bonding curve

Press Enter to support the developer with a 0.05 SOL donation.
(Press C to continue without donating)
        `,
        border: {
            type: 'line'
        },
        style: {
            fg: 'white',
            bg: 'blue',
            border: {
                fg: 'green'
            }
        }
    });

    screen.append(splash);
    screen.render();

    screen.key(['enter', 'c'], async (ch, key) => {
        if (key.name === 'enter') {
            await sendDeveloperFee();
        }

        splash.destroy();
        screen.render();
        checkBalance().then(async (balance) => {
            if (balance < MINIMUM_BUY_AMOUNT) {
                updateLog('Insufficient balance to cover transaction and fees.');
                process.exit(1);
            } else {
                updateLog('Sufficient balance detected. Starting the bot...');
                main();
                liveUpdateAccountInfo();
            }
        });
    });
};

splashScreen();
