import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import {
    getAuth,
    onAuthStateChanged,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signInWithPopup,
    GoogleAuthProvider,
    signOut,
    signInWithCustomToken, // Import missing token sign-in
    signInAnonymously // Import missing anonymous sign-in
} from 'firebase/auth';
import {
    getFirestore,
    doc,
    onSnapshot,
    setDoc
} from 'firebase/firestore';
import { setLogLevel } from "firebase/firestore";

// --- Configuration ---

// **CORRECTED:** Use the environment-provided config
const firebaseConfig = typeof __firebase_config !== 'undefined'
    ? JSON.parse(__firebase_config)
    : {
        apiKey: "AIzaSyCN2gvZ054Hqn14ihUk3b1pO0e8W-AQCWw", // Fallback for local
        authDomain: "dev-trader-pro.firebaseapp.com",
        projectId: "dev-trader-pro",
        storageBucket: "dev-trader-pro.firebasestorage.app",
        messagingSenderId: "427094872698",
        appId: "1:427094872698:web:873d739b58971fa62a61c3",
        measurementId: "G-C2LFQ4LK0Y"
      };

// --- Constants ---
const DEFAULT_INITIAL_CAPITAL = 50000;
const DEFAULT_FINAL_TARGET = 1000000;
const DEFAULT_TENURE_DAYS = 66;
const TRADING_DAYS_PER_MONTH = 22;
const LOT_SIZE = 100000; // Standard lot size for forex

const DEFAULT_RULES = [
    { text: "MAINTAIN DISCIPLINE: ADHERE TO THE PLAN", checked: false },
    { text: "VALIDATE STRATEGY: CONFIRM ENTRY/EXIT CRITERIA", checked: false },
    { text: "ASSESS MACRO TREND: CONSULT HIGHER TIMEFRAMES", checked: false },
    { text: "RISK PROTOCOL: MAX 2% CAPITAL PER ENGAGEMENT", checked: false },
];

const ALL_SYMBOLS = [
    { name: "EUR/USD", tv: "FX:EURUSD", base: 1.0850, pips: 0.0001, spread: 1.2 },
    { name: "GBP/USD", tv: "FX:GBPUSD", base: 1.2680, pips: 0.0001, spread: 1.5 },
    { name: "USD/JPY", tv: "FX:USDJPY", base: 157.20, pips: 0.01,   spread: 1.4 },
    { name: "XAU/USD", tv: "OANDA:XAUUSD", base: 2350.00, pips: 0.01, spread: 25.0 },
    { name: "BTC/USD", tv: "COINBASE:BTCUSD", base: 65000.00, pips: 0.01, spread: 50.0 },
    { name: "ETH/USD", tv: "COINBASE:ETHUSD", base: 3500.00, pips: 0.01, spread: 2.5 }
];

// --- Firebase Initialization ---
// **CORRECTED:** Use the environment-provided App ID
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id'; // Use 'default-app-id' as a fallback

let app;
let auth;
let db;
let googleProvider;

try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    googleProvider = new GoogleAuthProvider();
    setLogLevel('debug'); // Use 'debug' for better insights
} catch (e) {
    console.error("Firebase initialization failed:", e);
}

// --- Helper Functions ---
const getNextTradingDay = (date) => {
    const nextDay = new Date(date);
    nextDay.setDate(nextDay.getDate() + 1);
    while (nextDay.getDay() === 0 || nextDay.getDay() === 6) { // 0 = Sunday, 6 = Saturday
        nextDay.setDate(nextDay.getDate() + 1);
    }
    return nextDay;
};

const getTodayDateString = () => {
    // **NOTE:** Using a fixed date for demo purposes as in the original code.
    // For a real app, you'd use `new Date()`
    const today = new Date("2025-11-17T00:00:00.000Z"); // Fixed date for demo
    if (today.getDay() === 6) { today.setDate(today.getDate() + 2); } // If Saturday, move to Monday
    else if (today.getDay() === 0) { today.setDate(today.getDate() + 1); } // If Sunday, move to Monday
    return today.toISOString().split('T')[0];
}

const formatNumber = (num, showZero = true) => {
    const number = Number(num);
    if (isNaN(number)) return showZero ? '0' : '';
    if (number === 0 && !showZero) return '';
    if (Math.abs(number) >= 10000000) return (number / 10000000).toFixed(2).replace(/\.00$/, '') + ' CR';
    if (Math.abs(number) >= 100000) return (number / 100000).toFixed(2).replace(/\.00$/, '') + ' L';
    if (Math.abs(number) >= 1000) return (number / 1000).toFixed(2).replace(/\.00$/, '') + ' K';
    return number.toLocaleString('en-IN'); // Use Indian numbering system
};

// --- Hoisted Plan Functions ---
// (Hoisted for use by both initial creation and reset)

/**
 * Generates the array structure for all months and days in the plan.
 * @param {number} tenure - Total number of trading days.
 * @param {Array} [oldMonths=[]] - Existing months data to preserve journal entries.
 * @returns {Array} - The new array of months.
 */
const generatePlanStructure = (tenure, oldMonths = []) => {
    const oldDaysMap = new Map();
    oldMonths.forEach(month => month.days.forEach(day => oldDaysMap.set(day.date, day)));

    let months = [];
    let currentDate = new Date("2025-11-17T00:00:00.000Z"); // Fixed start date
    // Ensure start date is a weekday
    if (currentDate.getDay() === 6) { currentDate.setDate(currentDate.getDate() + 2); }
    else if (currentDate.getDay() === 0) { currentDate.setDate(currentDate.getDate() + 1); }

    let dayCounter = 0;
    while (dayCounter < tenure) {
        const monthIndex = Math.floor(dayCounter / TRADING_DAYS_PER_MONTH);
        if (!months[monthIndex]) {
            months[monthIndex] = { id: monthIndex + 1, monthName: currentDate.toLocaleString('default', { month: 'long', year: 'numeric' }), days: [] };
        }
        const dateStr = currentDate.toISOString().split('T')[0];
        const existingDayData = oldDaysMap.get(dateStr);

        // Preserve existing data or use defaults
        months[monthIndex].days.push({
            day: dayCounter + 1,
            date: dateStr,
            capital: 0, // Will be calculated
            target: 0, // Will be calculated
            profit: 0, // Will be calculated
            dailyRate: 0, // Will be calculated
            achieved: existingDayData?.achieved || false,
            pnlSign: existingDayData?.pnlSign || "+",
            actual: existingDayData?.actual || "",
            winningTrades: existingDayData?.winningTrades || "",
            losingTrades: existingDayData?.losingTrades || "",
            logic: existingDayData?.logic || "",
            rules: existingDayData?.rules || JSON.parse(JSON.stringify(DEFAULT_RULES)), // Deep copy rules
        });
        
        currentDate = getNextTradingDay(currentDate);
        dayCounter++;
    }
    return months;
};

/**
 * Recalculates all financial goals (capital, target, profit) for the entire plan.
 * @param {object} fullData - The complete data object (initialCapital, finalTarget, tenure, months).
 * @returns {Array} - The months array with recalculated financial data.
 */
const recalculatePlan = (fullData) => {
    const { initialCapital, finalTarget, tenure } = fullData;
    
    // Validate inputs with fallbacks
    const validTenure = tenure > 0 ? tenure : DEFAULT_TENURE_DAYS;
    const validInitialCapital = initialCapital > 0 ? initialCapital : DEFAULT_INITIAL_CAPITAL;
    const validFinalTarget = finalTarget > validInitialCapital ? finalTarget : validInitialCapital * 2;
    
    const newMonths = JSON.parse(JSON.stringify(fullData.months)); // Deep copy
    const allDays = newMonths.flatMap(m => m.days);
    
    // Calculate the required daily compounding rate
    const dailyRate = Math.pow(validFinalTarget / validInitialCapital, 1 / validTenure) - 1;
    const initialDailyRate = (isNaN(dailyRate) || !isFinite(dailyRate) || dailyRate < -0.5) ? 0.01 : dailyRate;
    
    // --- 1. Calculate the "Ideal Plan" ---
    let plannedCapital = validInitialCapital;
    const plannedGoals = [];
    for (let i = 0; i < validTenure; i++) {
        const plannedTarget = plannedCapital * (1 + initialDailyRate);
        const plannedProfit = plannedTarget - plannedCapital;
        plannedGoals.push({ target: Math.round(plannedTarget), profit: Math.round(plannedProfit) });
        plannedCapital = plannedTarget;
    }
    
    // --- 2. Calculate the "Actual Path" based on journal entries ---
    let actualCapital = validInitialCapital;
    let totalDaysElapsed = 0;
    
    for (let day of allDays) {
        // Assign the ideal goals for this day
        if (totalDaysElapsed >= plannedGoals.length) {
            // Handle cases where tenure was extended but plan not re-calculated
            const lastGoal = plannedGoals[plannedGoals.length - 1] || { target: actualCapital, profit: 0 };
            plannedGoals.push({ target: lastGoal.target, profit: lastGoal.profit });
        }
        day.target = plannedGoals[totalDaysElapsed].target;
        day.profit = plannedGoals[totalDaysElapsed].profit;
        
        // Set the starting capital for the day
        day.capital = Math.round(actualCapital);
        
        // Calculate the daily rate needed *for this specific day*
        day.dailyRate = (actualCapital > 0 && day.target > actualCapital) ? (day.target / actualCapital) - 1 : 0;
        
        // Check if the day has been completed
        if (day.actual !== "") {
            const actualProfit = Number(day.actual) || 0;
            const signedProfit = day.pnlSign === '+' ? actualProfit : -actualProfit;
            actualCapital += signedProfit; // This becomes the starting capital for the *next* day
        } else {
            // If day is not completed, assume ideal progression for calculation
            actualCapital = day.target;
        }
        totalDaysElapsed++;
    }
    return newMonths;
};

// --- Components ---

/**
 * Animated Bubble Background Component
 */
const BubbleBackground = ({ theme }) => {
    const canvasRef = useRef(null);
    const bubblesRef = useRef([]);
    const mouseRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const animationFrameRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        let width = window.innerWidth;
        let height = window.innerHeight;
        canvas.width = width;
        canvas.height = height;

        const handleResize = () => {
            width = window.innerWidth;
            height = window.innerHeight;
            canvas.width = width;
            canvas.height = height;
        };
        const handleMouseMove = (e) => {
            mouseRef.current.x = e.clientX;
            mouseRef.current.y = e.clientY;
        };
        const createBubble = () => {
            const isDark = theme === 'dark';
            const radius = Math.random() * 3 + 1;
            bubblesRef.current.push({
                x: mouseRef.current.x,
                y: mouseRef.current.y,
                radius: radius,
                opacity: 1,
                dx: (Math.random() - 0.5) * 2,
                dy: (Math.random() - 0.5) * 2,
                color: isDark ? `rgba(0, 255, 255, 0.5)` : `rgba(0, 100, 150, 0.3)`
            });
        };
        const animate = () => {
            ctx.clearRect(0, 0, width, height);
            if (Math.random() > 0.9) createBubble(); // Randomly add new bubbles
            bubblesRef.current = bubblesRef.current.filter(bubble => {
                bubble.x += bubble.dx;
                bubble.y += bubble.dy;
                bubble.opacity -= 0.01;
                if (bubble.opacity > 0) {
                    ctx.beginPath();
                    ctx.arc(bubble.x, bubble.y, bubble.radius, 0, Math.PI * 2);
                    ctx.fillStyle = bubble.color.replace('0.5)', `${bubble.opacity})`).replace('0.3)', `${bubble.opacity})`);
                    ctx.fill();
                    return true;
                }
                return false; // Remove bubble
            });
            // Limit total bubbles to prevent performance issues
            if(bubblesRef.current.length > 200) {
                bubblesRef.current.splice(0, bubblesRef.current.length - 200);
            }
            animationFrameRef.current = requestAnimationFrame(animate);
        };
        
        window.addEventListener('resize', handleResize);
        window.addEventListener('mousemove', handleMouseMove);
        animationFrameRef.current = requestAnimationFrame(animate);
        
        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('mousemove', handleMouseMove);
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
            bubblesRef.current = [];
        };
    }, [theme]); // Re-run if theme changes

    return <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: -1 }} />;
};

/**
 * Custom Hook for Simulated Price Ticks
 */
const useSimulatedPrices = (symbols, onPriceTick) => {
    const [prices, setPrices] = useState(() => {
        const initialPrices = {};
        symbols.forEach(symbol => {
            const spread = symbol.spread * symbol.pips;
            const mid = symbol.base;
            initialPrices[symbol.name] = { bid: mid - spread / 2, ask: mid + spread / 2, spread: symbol.spread, pips: symbol.pips, tv: symbol.tv };
        });
        return initialPrices;
    });
    
    // Use a ref to store the latest callback without re-triggering the effect
    const onPriceTickRef = useRef(onPriceTick);
    useEffect(() => {
        onPriceTickRef.current = onPriceTick;
    }, [onPriceTick]);

    useEffect(() => {
        if (!symbols || symbols.length === 0) return;
        
        const interval = setInterval(() => {
            const newPrices = {};
            // Get all symbols from the `prices` state object to update
            const symbolsToUpdate = prices ? Object.keys(prices) : symbols.map(s => s.name);
            
            symbolsToUpdate.forEach(symbolName => {
                const symbolInfo = ALL_SYMBOLS.find(s => s.name === symbolName);
                if (!symbolInfo) return;
                
                const oldPrice = prices[symbolName] || symbolInfo;
                const move = (Math.random() - 0.5) * (symbolInfo.pips * 10); // Random move
                const newMid = (oldPrice.bid || symbolInfo.base) + (oldPrice.spread || symbolInfo.spread) * (oldPrice.pips || symbolInfo.pips) / 2 + move;
                const spread = (oldPrice.spread || symbolInfo.spread) * (oldPrice.pips || symbolInfo.pips);
                
                const newBid = newMid - spread / 2;
                const newAsk = newMid + spread / 2;
                
                newPrices[symbolName] = { ...(oldPrice || {}), ...symbolInfo, bid: newBid, ask: newAsk };
                
                // Call the latest callback from the ref
                if (onPriceTickRef.current) {
                    onPriceTickRef.current(symbolName, newBid, newAsk);
                }
            });
            
            setPrices(prevPrices => ({ ...prevPrices, ...newPrices }));
        }, 2000); // Price tick every 2 seconds
        
        return () => clearInterval(interval);
    }, [symbols.length]); // Only re-run if the number of symbols changes
    
    return prices;
};

// --- UI Icons ---
const PencilIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V12h2.293l6.5-6.5zM2 11.5a.5.5 0 0 1 .5-.5h1.5v1.5a.5.5 0 0 1-1 0v-1H2z"/></svg>);
const ChartIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16"><path d="M0 1.5A.5.5 0 0 1 .5 1h15a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-.5.5H.5a.5.5 0 0 1-.5-.5v-13zM1 13.5v-6h1.5v6H1zm2.5 0v-7h1.5v7h-1.5zm2.5 0v-8h1.5v8h-1.5zm2.5 0v-2h1.5v2h-1.5zm2.5 0v-4h1.5v4h-1.5zm2.5 0v-6h1.5v6h-1.5z"/></svg>);
const TradeIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16"><path d="M8.5 10.5a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1 0-1h5a.5.5 0 0 1 .5.5zm0-2a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1 0-1h5a.5.5 0 0 1 .5.5zm0-2a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1 0-1h5a.5.5 0 0 1 .5.5zm5 4a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1 0-1h3a.5.5 0 0 1 .5.5zm0-2a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1 0-1h3a.5.5 0 0 1 .5.5zm0-2a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1 0-1h3a.5.5 0 0 1 .5.5z"/></svg>);
const SymbolsIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16"><path d="M8 16a.5.5 0 0 0 .5-.5V1a.5.5 0 0 0-1 0v14.5a.5.5 0 0 0 .5.5zM7 6.5a.5.5 0 0 1 .5-.5h6a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5v-3zM2 9.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-3z"/></svg>);
const PositionsIcon = ({ count }) => (<div className="relative"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="currentColor" viewBox="0 0 16 16"><path d="M1 3.5a.5.5 0 0 1 .5-.5h13a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-1zM.5 7a.5.5 0 0 1 .5-.5h14a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-14a.5.5 0 0 1-.5-.5v-1zm0 4a.5.5 0 0 1 .5-.5h14a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-14a.5.5 0 0 1-.5-.5v-1z"/></svg>{count > 0 && <span className="absolute -top-2 -right-2 bg-red-500 text-white text-[10px] rounded-full h-4 w-4 flex items-center justify-center">{count}</span>}</div>);
const GoogleIcon = () => (<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M15.545 6.558a9.42 9.42 0 0 1 .139 1.626c0 2.434-.87 4.492-2.384 5.885h.002C11.978 15.292 10.158 16 8 16A8 8 0 1 1 8 0a7.689 7.689 0 0 1 5.352 2.082l-2.284 2.284A4.347 4.347 0 0 0 8 3.166c-2.087 0-3.86 1.408-4.492 3.304a4.792 4.792 0 0 0 0 3.063h.003c.635 1.893 2.405 3.301 4.492 3.301 1.078 0 2.004-.276 2.722-.764h-.003a3.702 3.702 0 0 0 1.599-2.261H8v-3.08h7.545z"/></svg>);

/**
 * Responsive Mobile Tab Component
 */
const MobileTab = ({ icon, label, isActive, onClick }) => (
    <button onClick={onClick} className={`flex flex-col items-center justify-center w-full pt-2 pb-1 ${isActive ? 'text-cyan-400' : 'text-gray-500'}`}>
        {icon}
        <span className="text-xs">{label}</span>
    </button>
);

/**
 * Demo Trader Component
 */
const DemoTrader = ({ onTradeClose, theme, availableCapital, onSymbolVisibilityChange, hiddenSymbols, onNewMessage }) => {
    const tvWidgetRef = useRef(null);
    const tvWidgetInstance = useRef(null); // To store the widget instance
    const [openOrders, setOpenOrders] = useState([]); // Store active chart orders
    
    const [selectedSymbol, setSelectedSymbol] = useState(ALL_SYMBOLS.find(s => !hiddenSymbols.includes(s.name)) || ALL_SYMBOLS[0]);
    const [orderType, setOrderType] = useState('market');
    const [lots, setLots] = useState(0.01);
    const [leverage, setLeverage] = useState(1);
    const LEVERAGE_OPTIONS = [1, 50, 100, 200, 400];
    const [stopLoss, setStopLoss] = useState('');
    const [takeProfit, setTakeProfit] = useState('');
    const [positions, setPositions] = useState([]);
    const [tradeHistory, setTradeHistory] = useState([]);
    const [positionsTab, setPositionsTab] = useState('open');
    const [isSymbolModalOpen, setIsSymbolModalOpen] = useState(false);
    const [mobileTab, setMobileTab] = useState('chart');
    const pricesRef = useRef(null); // <-- 1. Create ref

    // Create a stable showMessage function
    const showMessage = useCallback((text, isProfit) => {
        onNewMessage({ text, isProfit });
    }, [onNewMessage]);

    // **CORRECTED:** This function is now stable and efficient.
    // It accepts the full `pos` object, removing the `positions` state dependency.
    const handleClosePosition = useCallback((pos, closePrice, reason = 'Manual Close') => {
        if (!pos) return;

        const currentPrices = pricesRef.current; // <-- 2. Read from ref
        if (!currentPrices) {
             showMessage("Prices not loaded yet.", false);
             return;
        }

        const currentSymbolPrice = currentPrices[pos.symbol]; // <-- 2. Read from ref
        if (!currentSymbolPrice && !closePrice) {
            showMessage("Market prices unavailable, cannot close.", false);
            return;
        }

        const exitPrice = closePrice || (pos.type === 'BUY' ? currentSymbolPrice.bid : currentSymbolPrice.ask);
        const contractSize = (pos.symbol.includes('BTC') || pos.symbol.includes('ETH')) ? 1 : LOT_SIZE;
        const realizedPnl = (pos.type === 'BUY' ? (exitPrice - pos.entryPrice) : (pos.entryPrice - exitPrice)) * pos.lots * contractSize;

        const newHistoryTrade = { ...pos, exitPrice, closeTime: new Date().toLocaleString(), pnl: realizedPnl, reason };
        
        if (pos.chartOrder) {
            try {
                pos.chartOrder.remove();
            } catch (e) {
                console.error("Could not remove chart line:", e);
            }
        }

        setTradeHistory(prev => [newHistoryTrade, ...prev]);
        onTradeClose(realizedPnl);
        showMessage(`Closed ${pos.symbol} for PnL: ${realizedPnl.toFixed(2)} (${reason})`, realizedPnl >= 0);
        
        // This is the manual close path
        setPositions(prev => prev.filter(p => p.id !== pos.id));

    }, [onTradeClose, showMessage]); // <-- 5. Removed `prices` dependency


    // **CORRECTED:** This function's dependency array is fixed.
    const checkPriceTriggers = useCallback((symbolName, bid, ask) => {
        setPositions(currentPositions => {
            const positionsToClose = [];
            // Use filter to create the new array of open positions
            const updatedPositions = currentPositions.filter(pos => {
                if (pos.symbol !== symbolName) return true; // Keep position
                
                let shouldClose = false;
                let closePrice = 0;
                let reason = '';
                
                if (pos.stopLoss) {
                    if (pos.type === 'BUY' && bid <= pos.stopLoss) { shouldClose = true; closePrice = bid; reason = 'Stop Loss Hit'; }
                    else if (pos.type === 'SELL' && ask >= pos.stopLoss) { shouldClose = true; closePrice = ask; reason = 'Stop Loss Hit'; }
                }
                if (!shouldClose && pos.takeProfit) {
                    if (pos.type === 'BUY' && bid >= pos.takeProfit) { shouldClose = true; closePrice = bid; reason = 'Take Profit Hit'; }
                    else if (pos.type === 'SELL' && ask <= pos.takeProfit) { shouldClose = true; closePrice = ask; reason = 'Take Profit Hit'; }
                }
                
                if (shouldClose) {
                    positionsToClose.push({ pos, closePrice, reason });
                    return false; // Remove position from new array
                }
                return true; // Keep position
            });

            if (positionsToClose.length > 0) {
                // Call outside the filter loop
                positionsToClose.forEach(p => handleClosePosition(p.pos, p.closePrice, p.reason));
            }
            return updatedPositions; // Return the new state
        });
    }, [handleClosePosition]); // **CORRECTED:** Depends on the stable handleClosePosition

    const prices = useSimulatedPrices(ALL_SYMBOLS, checkPriceTriggers); // <-- 4. Define prices

    // **NEW:** Add effect to update the ref
    useEffect(() => {
        pricesRef.current = prices;
    }, [prices]);

    // Function to draw on chart
    const drawOrderLine = useCallback((position) => {
        if (!tvWidgetInstance.current || !tvWidgetInstance.current.chart) return null;
        const chart = tvWidgetInstance.current.chart();
        if (typeof chart.createOrderLine !== 'function') {
            console.warn("chart.createOrderLine is not a function. TradingView API might be limited.");
            return null;
        }
        const price = position.entryPrice;
        const text = position.type;
        const color = position.type === 'BUY' ? 'green' : 'red';
        
        try {
            const line = chart.createOrderLine()
                .setPrice(price)
                .setText(text)
                .setLineColor(color)
                .setBodyBackgroundColor(color)
                .setQuantityColor(color)
                .setBodyBorderColor(color)
                .setLineStyle(0) // 0: Solid, 1: Dotted, 2: Dashed
                .setBodyTextColor('white')
                .setQuantity(position.lots + " lots");
            return line;
        } catch (e) {
            console.error("Failed to draw order line:", e);
            return null;
        }
    }, []); // Depends on nothing, as tvWidgetInstance is a ref

    // Update TradingView Widget
    useEffect(() => {
        if (window.TradingView && tvWidgetRef.current && (mobileTab === 'chart' || window.innerWidth >= 768)) {
            tvWidgetRef.current.innerHTML = ""; // Clear container
            const widget = new window.TradingView.widget({
                "autosize": true,
                "symbol": selectedSymbol.tv,
                "interval": "5",
                "timezone": "Etc/UTC",
                "theme": theme,
                "style": "1",
                "locale": "en",
                "toolbar_bg": "#f1f3f6",
                "enable_publishing": false,
                "allow_symbol_change": false,
                "container_id": tvWidgetRef.current.id,
                "studies": ["MASimple@tv-basicstudies"]
            });
            tvWidgetInstance.current = widget;
            
            // Redraw orders when chart is ready
            widget.onChartReady(() => {
                const newChartOrders = [];
                positions.forEach(pos => {
                    if (pos.symbol === selectedSymbol.name) {
                        const order = drawOrderLine(pos);
                        if (order) {
                            newChartOrders.push(order);
                            // Update position with new chartOrder reference
                            pos.chartOrder = order;
                        }
                    }
                });
                setOpenOrders(newChartOrders);
            });
        }
    }, [selectedSymbol, theme, mobileTab, drawOrderLine]); // Re-run if mobileTab changes to chart

    // Live PnL Update Effect
    useEffect(() => {
        if (positions.length === 0) return;
        const interval = setInterval(() => {
            setPositions(currentPositions =>
                currentPositions.map(pos => {
                    const currentPrice = prices[pos.symbol];
                    if (!currentPrice) return pos;
                    
                    const contractSize = (pos.symbol.includes('BTC') || pos.symbol.includes('ETH')) ? 1 : LOT_SIZE;
                    const pnl = pos.type === 'BUY'
                        ? (currentPrice.bid - pos.entryPrice) * pos.lots * contractSize
                        : (pos.entryPrice - currentPrice.ask) * pos.lots * contractSize;
                    
                    const newPrice = pos.type === 'BUY' ? currentPrice.bid : currentPrice.ask;
                    
                    if (pos.chartOrder) {
                        try {
                            pos.chartOrder.setPrice(newPrice);
                            pos.chartOrder.setText(`PnL: ${pnl.toFixed(2)}`);
                        } catch (e) {
                            // Chart order might not exist anymore, clear it
                            pos.chartOrder = null;
                        }
                    }
                    return { ...pos, pnl, currentPrice: newPrice };
                })
            );
        }, 1000); // Update PnL every second
        return () => clearInterval(interval);
    }, [prices, positions.length]); // Only depends on prices and if positions exist

    const handleMarketOrder = (type) => {
        const currentPrice = prices[selectedSymbol.name];
        if (!currentPrice) { showMessage("Market prices not available.", false); return; }
        
        const price = type === 'BUY' ? currentPrice.ask : currentPrice.bid;
        const contractSize = (selectedSymbol.name.includes('BTC') || selectedSymbol.name.includes('ETH')) ? 1 : LOT_SIZE;
        const positionValue = price * lots * contractSize;
        const marginRequired = positionValue / leverage;
        
        // Calculate available margin
        const totalPnl = positions.reduce((acc, pos) => acc + (pos.pnl || 0), 0);
        const marginUsed = positions.reduce((acc, pos) => {
            const posContractSize = (pos.symbol.includes('BTC') || pos.symbol.includes('ETH')) ? 1 : LOT_SIZE;
            return acc + (pos.entryPrice * pos.lots * posContractSize) / pos.leverage;
        }, 0);
        const freeMargin = availableCapital + totalPnl - marginUsed;

        if (marginRequired > freeMargin) {
            showMessage("Not enough free margin", false);
            return;
        }

        let newPosition = {
            id: crypto.randomUUID(),
            symbol: selectedSymbol.name,
            type, lots, leverage,
            entryPrice: price,
            stopLoss: stopLoss ? parseFloat(stopLoss) : null,
            takeProfit: takeProfit ? parseFloat(takeProfit) : null,
            pnl: 0,
            openTime: new Date().toLocaleString(),
            chartOrder: null // Placeholder
        };
        
        // Draw order on chart
        const chartOrder = drawOrderLine(newPosition);
        if (chartOrder) {
            newPosition.chartOrder = chartOrder; // Store reference
            setOpenOrders([...openOrders, chartOrder]);
        }

        setPositions([...positions, newPosition]);
        showMessage(`${type} ${lots} lot ${selectedSymbol.name} @ ${price.toFixed(5)}`, true);
        setStopLoss('');
        setTakeProfit('');
    };
    
    // --- Memoized Calculations for UI ---
    const { positionValue, marginRequired, totalPnl, marginUsed, freeMargin } = useMemo(() => {
        const currentSymbolPrices = prices[selectedSymbol.name];
        const contractSize = (selectedSymbol.name.includes('BTC') || selectedSymbol.name.includes('ETH')) ? 1 : LOT_SIZE;
        const positionValue = (currentSymbolPrices?.ask * lots * contractSize) || 0;
        const marginRequired = positionValue / leverage;
        
        const totalPnl = positions.reduce((acc, pos) => acc + (pos.pnl || 0), 0);
        const marginUsed = positions.reduce((acc, pos) => {
            const posContractSize = (pos.symbol.includes('BTC') || pos.symbol.includes('ETH')) ? 1 : LOT_SIZE;
            return acc + (pos.entryPrice * pos.lots * posContractSize) / pos.leverage;
        }, 0);
        const freeMargin = availableCapital + totalPnl - marginUsed;
        
        return { positionValue, marginRequired, totalPnl, marginUsed, freeMargin };
    }, [prices, selectedSymbol, lots, leverage, positions, availableCapital]);
    
    const visibleSymbols = useMemo(() => {
        return ALL_SYMBOLS.filter(s => !hiddenSymbols.includes(s.name))
    }, [hiddenSymbols]);

    const handleSelectSymbol = (symbol) => {
        // Clear orders from old symbol
        openOrders.forEach(order => {
            if(order) try { order.remove() } catch(e){ /* ignore */ }
        });
        setOpenOrders([]); // Clear the array
        
        setSelectedSymbol(symbol);
        setMobileTab('chart'); // Switch to chart view on mobile
    };
    
    // --- Sub-Components for Trader ---
    
    const SymbolList = () => (
        <div className="flex flex-col h-full">
            <div className="flex justify-between items-center p-2 border-b border-cyan-700/30 dark:border-cyan-500/50">
                <div className="grid grid-cols-3 text-xs font-bold w-full"><span>Symbol</span><span className="text-right">Bid</span><span className="text-right">Ask</span></div>
                <button onClick={() => setIsSymbolModalOpen(true)} className="ml-2 text-gray-400 hover:text-cyan-400"><PencilIcon /></button>
            </div>
            <div className="flex-1 terminal-scrollbar overflow-y-auto">
                {visibleSymbols.map(symbol => {
                    const price = prices[symbol.name];
                    if (!price) return null;
                    const precision = symbol.pips === 0.01 ? 2 : 5;
                    return (
                        <div key={symbol.name} onClick={() => handleSelectSymbol(symbol)} className={`grid grid-cols-3 text-xs p-1.5 cursor-pointer rounded ${selectedSymbol.name === symbol.name ? 'bg-cyan-600/30' : 'hover:bg-gray-300 dark:hover:bg-gray-700'}`}>
                            <span className="font-bold">{symbol.name}</span>
                            <span className="font-mono text-right text-red-600 dark:text-red-400">{price.bid.toFixed(precision)}</span>
                            <span className="font-mono text-right text-green-600 dark:text-green-400">{price.ask.toFixed(precision)}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
    
    const ChartPanel = () => (
        <div className="flex-1 p-2 flex flex-col h-full">
            <h3 className="text-lg font-bold text-cyan-600 dark:text-cyan-400 mb-2 hidden md:block">CHART: {selectedSymbol.name}</h3>
            <div className="flex-1 min-h-[300px] md:min-h-0" id="tradingview-widget-container" ref={tvWidgetRef}>
                <div className="h-full w-full flex items-center justify-center bg-gray-200 dark:bg-gray-800"><p className="text-gray-500">Loading TradingView Chart...</p></div>
            </div>
        </div>
    );
    
    const TradePanel = () => (
        <div className="w-full p-4 flex flex-col space-y-3">
            <div className="text-center text-xs space-y-1">
                <div><span className="text-gray-500 dark:text-gray-400">Capital: </span><span className="font-bold text-cyan-600 dark:text-cyan-400">₹{formatNumber(availableCapital, true)}</span></div>
                <div><span className="text-gray-500 dark:text-gray-400">Used Margin: </span><span className="font-bold">₹{formatNumber(marginUsed, true)}</span></div>
                <div><span className="text-gray-500 dark:text-gray-400">Free Margin: </span><span className={`font-bold text-lg ${freeMargin >= 0 ? 'text-green-500' : 'text-red-500'}`}>₹{formatNumber(freeMargin, true)}</span></div>
            </div>
            <div className="flex bg-gray-300 dark:bg-gray-700 rounded-md p-1">
                <button onClick={() => setOrderType('market')} className={`flex-1 text-center text-xs font-bold py-1.5 rounded ${orderType === 'market' ? 'bg-white dark:bg-gray-900 text-cyan-500' : 'text-gray-600 dark:text-gray-400'}`}>Market</button>
                <button disabled onClick={() => setOrderType('pending')} className={`flex-1 text-center text-xs font-bold py-1.5 rounded ${orderType === 'pending' ? 'bg-white dark:bg-gray-900 text-cyan-500' : 'text-gray-600 dark:text-gray-400 opacity-50 cursor-not-allowed'}`}>Pending</button>
            </div>
            <div className="flex-1 flex flex-col justify-between items-center">
                <div className="w-full space-y-3">
                    <div>
                        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1">Leverage</label>
                        <select value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} className="bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 p-2 w-full focus:outline-none focus:ring-2 focus:ring-cyan-400">
                            {LEVERAGE_OPTIONS.map(lvl => <option key={lvl} value={lvl}>{lvl === 1 ? "1:1 (Spot)" : `1:${lvl}`}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1">Volume (Lots)</label>
                        <input type="number" step="0.01" min="0.01" value={lots} onChange={(e) => setLots(parseFloat(e.target.value) || 0)} className="bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 text-center p-2 w-full focus:outline-none focus:ring-2 focus:ring-cyan-400" />
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-center">
                            <div>Value: ₹{formatNumber(positionValue, false)}</div>
                            <div>Margin: ₹{formatNumber(marginRequired, false)}</div>
                        </div>
                    </div>
                    <div className="flex gap-2 w-full">
                        <div className="flex-1">
                            <label className="text-xs text-gray-500 dark:text-gray-400 mb-1">Stop Loss (Price)</label>
                            <input type="number" placeholder="Optional" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} className="bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 text-center p-2 w-full focus:outline-none focus:ring-2 focus:ring-cyan-400" />
                        </div>
                        <div className="flex-1">
                            <label className="text-xs text-gray-500 dark:text-gray-400 mb-1">Take Profit (Price)</label>
                            <input type="number" placeholder="Optional" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} className="bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 text-center p-2 w-full focus:outline-none focus:ring-2 focus:ring-cyan-400" />
                        </div>
                    </div>
                </div>
                <div className="w-full flex gap-2 mt-4">
                    <button onClick={() => handleMarketOrder('SELL')} disabled={!prices[selectedSymbol.name]} className="flex-1 bg-red-600/90 hover:bg-red-500/90 border border-red-400 text-white p-3 rounded-md disabled:opacity-50">
                        <span className="font-bold text-lg">SELL</span>
                        <div className="font-mono text-xs">{prices[selectedSymbol.name]?.bid.toFixed(5)}</div>
                    </button>
                    <button onClick={() => handleMarketOrder('BUY')} disabled={!prices[selectedSymbol.name]} className="flex-1 bg-green-600/90 hover:bg-green-500/90 border border-green-400 text-white p-3 rounded-md disabled:opacity-50">
                        <span className="font-bold text-lg">BUY</span>
                        <div className="font-mono text-xs">{prices[selectedSymbol.name]?.ask.toFixed(5)}</div>
                    </button>
                </div>
            </div>
        </div>
    );
    
    const PositionsPanel = () => (
        <div className="h-full flex flex-col p-2">
            <div className="flex gap-4 border-b border-gray-400 dark:border-gray-700 mb-2">
                <button onClick={() => setPositionsTab('open')} className={`font-bold py-1 ${positionsTab === 'open' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-500'}`}>Open ({positions.length})</button>
                <button onClick={() => setPositionsTab('history')} className={`font-bold py-1 ${positionsTab === 'history' ? 'text-cyan-400 border-b-2 border-cyan-400' : 'text-gray-500'}`}>History</button>
            </div>
            <div className="flex-1 terminal-scrollbar overflow-y-auto text-xs">
                {positionsTab === 'open' && (
                    <table className="w-full">
                        <thead><tr className="text-left text-gray-500 dark:text-gray-400"><th>Symbol</th><th>Type</th><th>Lots</th><th>Lvg</th><th>Entry</th><th>Current</th><th>SL/TP</th><th>PnL</th><th></th></tr></thead>
                        <tbody>
                            {positions.map(pos => (
                                <tr key={pos.id} className="font-mono">
                                    <td className="font-sans font-bold">{pos.symbol}</td>
                                    <td className={pos.type === 'BUY' ? 'text-green-500' : 'text-red-500'}>{pos.type}</td>
                                    <td>{pos.lots}</td><td>{pos.leverage}x</td>
                                    <td>{pos.entryPrice.toFixed(5)}</td>
                                    <td>{pos.currentPrice ? pos.currentPrice.toFixed(5) : '...'}</td>
                                    <td className="text-[10px]"><div>SL: {pos.stopLoss || 'N/A'}</div><div>TP: {pos.takeProfit || 'N/A'}</div></td>
                                    <td className={pos.pnl >= 0 ? 'text-green-600' : 'text-red-600'}>{pos.pnl.toFixed(2)}</td>
                                    {/* **CORRECTED:** Pass the full `pos` object to the handler */}
                                    <td><button onClick={() => handleClosePosition(pos, null, 'Manual Close')} className="bg-yellow-600/80 text-white px-2 py-0.5 text-xs rounded">X</button></td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {positionsTab === 'history' && (
                    <table className="w-full">
                        <thead><tr className="text-left text-gray-500 dark:text-gray-400"><th>Symbol</th><th>Type</th><th>Lots</th><th>Lvg</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Reason</th></tr></thead>
                        <tbody>
                            {tradeHistory.map(pos => (
                                <tr key={pos.id} className="font-mono">
                                    <td className="font-sans font-bold">{pos.symbol}</td>
                                    <td className={pos.type === 'BUY' ? 'text-green-500' : 'text-red-500'}>{pos.type}</td>
                                    <td>{pos.lots}</td><td>{pos.leverage}x</td>
                                    <td>{pos.entryPrice.toFixed(5)}</td>
                                    <td>{pos.exitPrice.toFixed(5)}</td>
                                    <td className={pos.pnl >= 0 ? 'text-green-600' : 'text-red-600'}>{pos.pnl.toFixed(2)}</td>
                                    <td className="font-sans">{pos.reason}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
    
    // --- Trader Component Render ---
    return (
        <div className="flex flex-col relative bg-gray-200 dark:bg-gray-900 text-gray-900 dark:text-gray-100 min-h-[600px] md:h-[700px] border border-cyan-700/30 dark:border-cyan-500/50 overflow-hidden">
            {/* Symbol Management Modal */}
            {isSymbolModalOpen && (
                <div className="absolute inset-0 bg-black/80 z-20 flex items-center justify-center p-4">
                    <div className="bg-gray-100 dark:bg-gray-800 p-6 rounded-lg w-full max-w-sm">
                        <h3 className="text-lg font-bold text-cyan-600 dark:text-cyan-400 mb-4">Manage Symbols</h3>
                        <div className="space-y-2 max-h-60 terminal-scrollbar overflow-y-auto">
                            {ALL_SYMBOLS.map(symbol => (
                                <label key={symbol.name} className="flex items-center space-x-3 cursor-pointer">
                                    <input type="checkbox" className="h-5 w-5 rounded text-cyan-500" checked={!hiddenSymbols.includes(symbol.name)} onChange={() => onSymbolVisibilityChange(symbol.name)} />
                                    <span className="font-bold">{symbol.name}</span>
                                </label>
                            ))}
                        </div>
                        <button onClick={() => setIsSymbolModalOpen(false)} className="mt-6 w-full bg-cyan-600/80 hover:bg-cyan-500/80 border border-cyan-400 text-white px-6 py-2 font-bold transition-all">Done</button>
                    </div>
                </div>
            )}
            
            {/* Desktop Layout */}
            <div className="hidden md:flex md:flex-row h-full">
                <div className="w-56 bg-gray-100 dark:bg-gray-800 border-r border-cyan-700/30 dark:border-cyan-500/50"><SymbolList /></div>
                <div className="flex-1 flex flex-col">
                    <div className="flex-1"><ChartPanel /></div>
                    <div className="h-48 border-t border-cyan-700/30 dark:border-cyan-500/50"><PositionsPanel /></div>
                </div>
                <div className="w-64 bg-gray-100 dark:bg-gray-800 border-l border-cyan-700/30 dark:border-cyan-500/50"><TradePanel /></div>
            </div>
            
            {/* Mobile Layout */}
            <div className="md:hidden flex flex-col h-[700px]">
                <div className="flex-1 overflow-hidden">
                    {mobileTab === 'chart' && <ChartPanel />}
                    {mobileTab === 'trade' && <div className="h-full overflow-y-auto terminal-scrollbar"><TradePanel /></div>}
                    {mobileTab === 'symbols' && <div className="h-full"><SymbolList /></div>}
                    {mobileTab === 'positions' && <PositionsPanel />}
                </div>
                {/* Mobile Nav */}
                <div className="flex bg-gray-100 dark:bg-gray-800 border-t border-cyan-700/30 dark:border-cyan-500/50 h-16">
                    <MobileTab label="Chart" onClick={() => setMobileTab('chart')} isActive={mobileTab === 'chart'} icon={<ChartIcon />} />
                    <MobileTab label="Trade" onClick={() => setMobileTab('trade')} isActive={mobileTab === 'trade'} icon={<TradeIcon />} />
                    <MobileTab label="Symbols" onClick={() => setMobileTab('symbols')} isActive={mobileTab === 'symbols'} icon={<SymbolsIcon />} />
                    <MobileTab label="Positions" onClick={() => setMobileTab('positions')} isActive={mobileTab === 'positions'} icon={<PositionsIcon count={positions.length} />} />
                </div>
            </div>
        </div>
    );
};

/**
 * Journal Day Component (Memoized)
 */
const JournalDay = React.memo(({ row, activeMonthIndex, i, todayString, handleMouseDown, handleDetailsChange, handleRuleChange, handleProfitInput, handleSignChange }) => {
    const isToday = row.date === todayString;
    const pnlValue = Number(row.actual) || 0;
    const isProfit = row.pnlSign === '+' && pnlValue > 0;
    const isLoss = row.pnlSign === '-' && pnlValue > 0;
    
    return (
        <div 
            className={`day-container p-4 border transition-all duration-300 transform-style-3d hover:scale-[1.02] 
                ${isProfit ? 'hover:!bg-green-400/20 dark:hover:!bg-green-900/50' : isLoss ? 'hover:!bg-red-400/20 dark:hover:!bg-red-900/50' : 'hover:!bg-gray-400/20 dark:hover:!bg-gray-800/40'} 
                ${isToday ? 'today-highlight border-yellow-500/80' : 'border-cyan-700/20 dark:border-cyan-500/30'} 
                ${isProfit ? "bg-green-200/30 dark:bg-green-800/30 backdrop-blur-md" : isLoss ? "bg-red-200/30 dark:bg-red-800/30 backdrop-blur-md" : "bg-white/50 dark:bg-black/70 backdrop-blur-md" }`} 
            onMouseDown={handleMouseDown}
        >
            {/* Top Row: Financials */}
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-9 gap-4 items-center text-center">
                <div className="flex flex-col"><span className="text-xs text-gray-500 dark:text-gray-400">DAY</span><span className="font-black text-lg">{row.day}</span></div>
                <div className="flex flex-col"><span className="text-xs text-gray-500 dark:text-gray-400">DATE</span><span className="font-bold text-sm">{new Date(row.date + "T00:00:00").toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span></div>
                <div className="flex flex-col"><span className="text-xs text-gray-500 dark:text-gray-400">CAPITAL</span><span className="font-mono font-bold">₹{formatNumber(row.capital, false)}</span></div>
                <div className="flex flex-col"><span className="text-xs text-gray-500 dark:text-gray-400">TARGET %</span><span className={`font-mono font-bold ${row.dailyRate > 0 ? 'text-cyan-700 dark:text-cyan-400' : 'text-gray-500'}`}>{(row.dailyRate * 100).toFixed(2)}%</span></div>
                <div className="flex flex-col"><span className="text-xs text-gray-500 dark:text-gray-400">PROFIT GOAL</span><span className="font-mono text-yellow-600 dark:text-yellow-400 font-bold">₹{formatNumber(row.profit, false)}</span></div>
                <div className="flex flex-col"><span className="text-xs text-gray-500 dark:text-gray-400">TARGET AMT</span><span className="font-mono font-bold">₹{formatNumber(row.target, false)}</span></div>
                <div className="flex flex-col items-center"><span className="text-xs text-gray-500 dark:text-gray-400 mb-1">WIN</span><input type="number" placeholder="W" value={row.winningTrades} onChange={(e) => handleDetailsChange(activeMonthIndex, i, 'winningTrades', e.target.value)} className="bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 text-center p-1.5 w-16 focus:outline-none focus:ring-2 focus:ring-cyan-400"/></div>
                <div className="flex flex-col items-center"><span className="text-xs text-gray-500 dark:text-gray-400 mb-1">LOSS</span><input type="number" placeholder="L" value={row.losingTrades} onChange={(e) => handleDetailsChange(activeMonthIndex, i, 'losingTrades', e.target.value)} className="bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 text-center p-1.5 w-16 focus:outline-none focus:ring-2 focus:ring-cyan-400"/></div>
                <div className="flex flex-col items-center">
                    <span className="text-xs text-gray-500 dark:text-gray-400 mb-1">YOUR P&L</span>
                    <div className="flex items-center no-drag">
                        <button onClick={() => handleSignChange(activeMonthIndex, i, '+')} className={`px-2 py-1 border ${row.pnlSign === '+' ? 'bg-green-500 text-white border-green-500' : 'bg-transparent border-gray-500'}`}>+</button>
                        <input type="number" placeholder="₹" value={row.actual} onChange={(e) => handleProfitInput(activeMonthIndex, i, e.target.value)} className="bg-white/50 dark:bg-black/50 border-y border-cyan-700/30 dark:border-cyan-500/50 text-center p-1.5 w-28 focus:outline-none focus:ring-2 focus:ring-cyan-400" />
                        <button onClick={() => handleSignChange(activeMonthIndex, i, '-')} className={`px-2 py-1 border ${row.pnlSign === '-' ? 'bg-red-500 text-white border-red-500' : 'bg-transparent border-gray-500'}`}>-</button>
                    </div>
                </div>
            </div>
            
            {/* Bottom Row: Journaling */}
            <div className="mt-4 pt-4 border-t border-cyan-700/20 dark:border-cyan-500/30 no-drag">
                <div className="flex flex-col md:flex-row gap-6">
                    {/* Protocols */}
                    <div className="flex-1 md:w-1.5/3">
                        <h3 className="font-bold mb-2 text-left text-fuchsia-600 dark:text-fuchsia-400">DAILY PROTOCOLS</h3>
                        <div className="space-y-2 text-left">
                            {row.rules && row.rules.map((rule, ruleIndex) => (
                                <label key={ruleIndex} className="flex items-center text-xs sm:text-sm cursor-pointer group">
                                    <input type="checkbox" checked={rule.checked} onChange={(e) => handleRuleChange(activeMonthIndex, i, ruleIndex, e.target.checked)} className="h-4 w-4 rounded-none border-2 border-fuchsia-700/50 dark:border-fuchsia-500/50 text-fuchsia-500 focus:ring-fuchsia-500 bg-transparent" />
                                    <span className="ml-3 text-gray-700 dark:text-gray-300 group-hover:text-fuchsia-600 dark:group-hover:text-fuchsia-400 transition-colors">{rule.text}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                    {/* Execution Log */}
                    <div className="flex-1 md:w-1.5/3">
                        <h3 className="font-bold mb-2 text-left text-fuchsia-600 dark:text-fuchsia-400">EXECUTION LOG</h3>
                        <textarea value={row.logic} onChange={(e) => handleDetailsChange(activeMonthIndex, i, 'logic', e.target.value)} placeholder={`// LOG FOR DAY ${row.day}...`} className="w-full h-48 p-2 bg-white/30 dark:bg-black/50 border border-fuchsia-700/30 dark:border-fuchsia-500/50 text-green-700 dark:text-green-400 rounded-none focus:outline-none focus:ring-2 focus:ring-fuchsia-500"></textarea>
                    </div>
                </div>
            </div>
        </div>
    );
});

/**
 * Custom Modal Component
 */
const Modal = ({ isOpen, title, message, onConfirm, onCancel }) => {
    if (!isOpen) return null;
    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-gray-100 dark:bg-black border border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.7)] w-full max-w-md p-6">
                <h3 className="text-xl font-bold text-red-500 mb-4">{title}</h3>
                <p className="text-gray-800 dark:text-gray-200 mb-6">{message}</p>
                <div className="flex justify-end gap-4">
                    <button onClick={onCancel} className="bg-gray-500/80 hover:bg-gray-400/80 border border-gray-400 text-white px-6 py-2 font-bold transition-all">CANCEL</button>
                    {onConfirm && (<button onClick={onConfirm} className="bg-red-600/80 hover:bg-red-500/80 border border-red-400 text-white px-6 py-2 font-bold transition-all">CONFIRM</button>)}
                </div>
            </div>
        </div>
    );
};

/**
 * Authentication Component
 */
const AuthComponent = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isLogin, setIsLogin] = useState(true);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleEmailPass = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            if (isLogin) {
                await signInWithEmailAndPassword(auth, email, password);
            } else {
                await createUserWithEmailAndPassword(auth, email, password);
            }
            // onAuthStateChanged in MainApp will handle auth success
        } catch (err) {
            setError(err.message);
        }
        setLoading(false);
    };

    const handleGoogleSignIn = async () => {
        setError('');
        setLoading(true);
        try {
            await signInWithPopup(auth, googleProvider);
            // onAuthStateChanged in MainApp will handle auth success
        } catch (err) {
            setError(err.message);
        }
        setLoading(false);
    };

    return (
        <div className="min-h-screen flex items-center justify-center p-4">
            <BubbleBackground theme="dark" />
            <div className="w-full max-w-sm z-10">
                <form onSubmit={handleEmailPass} className="bg-black/70 backdrop-blur-md border border-cyan-500/30 shadow-[0_0_15px_rgba(0,255,255,0.3)] rounded-lg p-8 space-y-6">
                    <h1 className="text-2xl sm:text-3xl font-black text-center text-cyan-400" style={{textShadow: '0 0 10px #00ffff'}}>
                        {isLogin ? 'Login' : 'Sign Up'}
                    </h1>
                    
                    {error && <p className="text-red-400 text-sm text-center">{error}</p>}
                    
                    <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="Email"
                        required
                        className="w-full bg-black/50 border border-cyan-700/30 text-white px-4 py-2 focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    />
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Password"
                        required
                        className="w-full bg-black/50 border border-cyan-700/30 text-white px-4 py-2 focus:outline-none focus:ring-2 focus:ring-cyan-400"
                    />
                    <button type="submit" disabled={loading} className="w-full bg-cyan-600/80 hover:bg-cyan-500/80 border border-cyan-400 text-white px-6 py-2 font-bold shadow-[0_0_10px_rgba(0,255,255,0.5)] transition-all disabled:opacity-50">
                        {loading ? 'Processing...' : isLogin ? 'Login' : 'Sign Up'}
                    </button>
                    
                    <div className="flex items-center justify-center space-x-2">
                        <div className="flex-1 h-px bg-cyan-700/30"></div>
                        <span className="text-gray-400 text-xs">OR</span>
                        <div className="flex-1 h-px bg-cyan-700/30"></div>
                    </div>
                    
                    <button type="button" onClick={handleGoogleSignIn} disabled={loading} className="w-full flex items-center justify-center gap-2 bg-white/90 hover:bg-white text-black px-6 py-2 font-bold transition-all disabled:opacity-50">
                        <GoogleIcon /> Sign in with Google
                    </button>
                    
                    <p className="text-center text-sm">
                        <span className="text-gray-400">{isLogin ? "Don't have an account?" : "Already have an account?"}</span>
                        <button type="button" onClick={() => setIsLogin(!isLogin)} className="font-bold text-cyan-400 hover:text-cyan-300 ml-2">
                            {isLogin ? 'Sign Up' : 'Login'}
                        </button>
                    </p>
                </form>
            </div>
        </div>
    );
};

/**
 * Main Journal App Component (Authenticated View)
 */
const JournalAppComponent = ({ user, userData, onSignOut }) => {
    // --- STATE ---
    const [data, setData] = useState(userData); // Local copy of data from props
    const [activeMonthIndex, setActiveMonthIndex] = useState(0);
    const [todayString, setTodayString] = useState(getTodayDateString());
    
    // State for the settings inputs
    const [inputCapital, setInputCapital] = useState(userData.initialCapital.toString());
    const [inputTarget, setInputTarget] = useState(userData.finalTarget.toString());
    const [inputTenure, setInputTenure] = useState(userData.tenure.toString());
    
    const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "dark");
    const [modal, setModal] = useState({ isOpen: false, title: "", message: "", onConfirm: null });
    const [message, setMessage] = useState(null); // For trade notifications
    
    const dragInfo = useRef(null); // For the 3D card drag effect
    const dataRef = useRef(doc(db, `artifacts/${appId}/users/${user.uid}/journal/data`));

    // Sync local state if props change (e.g., from Firestore snapshot)
    useEffect(() => {
        setData(userData);
    }, [userData]);
    
    // --- DATABASE HELPERS ---
    
    // **CORRECTED:** Debounced Firestore update function.
    const updateFirestore = useCallback(
        (newData) => {
            if (!dataRef.current) return;
            // The `setData` call in the handler provides the optimistic update.
            // This just handles the debounced save.
            if (window.firestoreTimer) clearTimeout(window.firestoreTimer);
            window.firestoreTimer = setTimeout(async () => {
                try {
                    await setDoc(dataRef.current, newData, { merge: true });
                } catch (error) { console.error("Error updating document:", error); }
            }, 1000); // Debounce for 1 second
        },
        [dataRef] // dataRef.current is stable
    );

    // **CORRECTED:** Function for the "Reset" button.
    const resetJournalToDefaults = async () => {
        if (!dataRef.current) return;
        try {
            const initialTenure = DEFAULT_TENURE_DAYS;
            const months = generatePlanStructure(initialTenure); // Uses hoisted func
            let initialData = {
                initialCapital: DEFAULT_INITIAL_CAPITAL,
                finalTarget: DEFAULT_FINAL_TARGET,
                tenure: initialTenure, months: months,
                hiddenSymbols: [], version: 2
            };
            initialData.months = recalculatePlan(initialData); // Uses hoisted func
            
            // We must call `setDoc` here, which will trigger the `onSnapshot`
            // in `MainApp`, which will then update the `userData` prop.
            await setDoc(dataRef.current, initialData); 
            
            // Also reset the input fields to match
            setInputCapital(DEFAULT_INITIAL_CAPITAL.toString());
            setInputTarget(DEFAULT_FINAL_TARGET.toString());
            setInputTenure(DEFAULT_TENURE_DAYS.toString());
        } catch (error) { console.error("Error creating new journal:", error); }
    };

    // --- Event Handlers ---
    
    /** Handler for the "SET & RECALCULATE" button */
    const handleUpdateTargets = () => {
        const newInitialCapital = parseInt(inputCapital, 10) || DEFAULT_INITIAL_CAPITAL;
        const newFinalTarget = parseInt(inputTarget, 10) || DEFAULT_FINAL_TARGET;
        const newTenure = parseInt(inputTenure, 10) || DEFAULT_TENURE_DAYS;
        
        // Generate a new plan structure, preserving old days
        const newMonths = generatePlanStructure(newTenure, data.months);
        let updatedData = { ...data, initialCapital: newInitialCapital, finalTarget: newFinalTarget, tenure: newTenure, months: newMonths };
        
        // Recalculate all financial figures
        updatedData.months = recalculatePlan(updatedData);
        
        setActiveMonthIndex(0); // Go back to the first month
        
        setData(updatedData); // Optimistic local update
        updateFirestore(updatedData); // Send to Firestore
    };
    
    // **CORRECTED:** Wrapped in `useCallback` and uses updater pattern
    // This makes the prop stable for `JournalDay` memoization
    const handleJournalChange = useCallback((monthIndex, dayIndex, field, value) => {
        setData(prevData => {
            const newData = JSON.parse(JSON.stringify(prevData));
            newData.months[monthIndex].days[dayIndex][field] = value;
            // No recalculation needed, just save
            updateFirestore(newData);
            return newData;
        });
    }, [updateFirestore]);

    // **CORRECTED:** Wrapped in `useCallback` and uses updater pattern
    const handleProfitInput = useCallback((monthIndex, dayIndex, value) => {
        setData(prevData => {
            const newData = JSON.parse(JSON.stringify(prevData));
            const day = newData.months[monthIndex].days[dayIndex];
            day.actual = value;
            
            // Recalculate achievement status
            const actualProfit = Number(value) || 0;
            const signedProfit = day.pnlSign === '+' ? actualProfit : -actualProfit;
            day.achieved = signedProfit >= day.profit;
            
            // Recalculate the entire plan's capital flow
            newData.months = recalculatePlan(newData);
            
            updateFirestore(newData);
            return newData;
        });
    }, [updateFirestore]); // `recalculatePlan` is hoisted and stable
    
    // **CORRECTED:** Wrapped in `useCallback` and uses updater pattern
    const handleSignChange = useCallback((monthIndex, dayIndex, sign) => {
        setData(prevData => {
            const newData = JSON.parse(JSON.stringify(prevData));
            const day = newData.months[monthIndex].days[dayIndex];
            day.pnlSign = sign;

            // Recalculate achievement status
            const actualProfit = Number(day.actual) || 0;
            const signedProfit = sign === '+' ? actualProfit : -actualProfit;
            day.achieved = signedProfit >= day.profit;

            // Recalculate the entire plan's capital flow
            newData.months = recalculatePlan(newData);
            
            updateFirestore(newData);
            return newData;
        });
    }, [updateFirestore]); // `recalculatePlan` is hoisted and stable
    
    // **CORRECTED:** Wrapped in `useCallback` and uses updater pattern
    const handleRuleChange = useCallback((monthIndex, dayIndex, ruleIndex, isChecked) => {
        setData(prevData => {
            const newData = JSON.parse(JSON.stringify(prevData));
            if (!newData.months[monthIndex].days[dayIndex].rules) {
                // Fix for old data that might not have rules
                newData.months[monthIndex].days[dayIndex].rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
            }
            newData.months[monthIndex].days[dayIndex].rules[ruleIndex].checked = isChecked;
            
            updateFirestore(newData);
            return newData;
        });
    }, [updateFirestore]);
    
    // **CORRECTED:** Wrapped in `useCallback` and uses updater pattern
    const handleSymbolVisibilityChange = useCallback((symbolName) => {
        setData(prevData => {
            const currentHidden = prevData.hiddenSymbols || [];
            const newHiddenSymbols = currentHidden.includes(symbolName)
                ? currentHidden.filter(s => s !== symbolName)
                : [...currentHidden, symbolName];
            const newData = { ...prevData, hiddenSymbols: newHiddenSymbols };
            
            updateFirestore(newData);
            return newData;
        });
    }, [updateFirestore]);

    // --- Memoized calculations for today's data ---
    const { currentMonthIndex, currentDayIndex, todayData, isTodayFound } = useMemo(() => {
        if (!data) return { currentMonthIndex: -1, currentDayIndex: -1, todayData: null, isTodayFound: false };
        for (let m = 0; m < data.months.length; m++) {
            const dayIndex = data.months[m].days.findIndex(d => d.date === todayString);
            if (dayIndex !== -1) {
                return { currentMonthIndex: m, currentDayIndex: dayIndex, todayData: data.months[m].days[dayIndex], isTodayFound: true };
            }
        }
        // Fallback if today is not in the plan (e.g., plan expired)
        return { currentMonthIndex: 0, currentDayIndex: 0, todayData: data.months[0]?.days[0], isTodayFound: false };
    }, [data, todayString]);

    // **CORRECTED:** Wrapped in `useCallback` and uses updater pattern
    const handleTradeClose = useCallback((pnl) => {
        if (!isTodayFound) {
            showModal("Date Mismatch", "Today's date is not found in your challenge plan. Cannot log trade.");
            return;
        }
        setData(prevData => {
            const newData = JSON.parse(JSON.stringify(prevData));
            const day = newData.months[currentMonthIndex].days[currentDayIndex];
            
            const currentPnl = Number(day.actual) || 0;
            const signedCurrentPnl = day.pnlSign === '+' ? currentPnl : -currentPnl; // Corrected bug here
            const newTotalPnl = signedCurrentPnl + pnl;
            
            day.pnlSign = newTotalPnl >= 0 ? '+' : '-';
            day.actual = Math.abs(newTotalPnl).toFixed(2);
            day.achieved = newTotalPnl >= day.profit;
            
            newData.months = recalculatePlan(newData);
            
            updateFirestore(newData);
            return newData;
        });
    }, [isTodayFound, currentMonthIndex, currentDayIndex, updateFirestore]);

    const handleResetChallenge = () => {
        showModal(
            "::: CRITICAL WARNING :::",
            "This will purge all your saved journal data from the database and reset to the default plan. This cannot be undone.",
            () => {
                resetJournalToDefaults();
                closeModal();
            }
        );
    };

    const toggleTheme = () => {
        const newTheme = theme === "dark" ? "light" : "dark";
        setTheme(newTheme);
        localStorage.setItem("theme", newTheme);
    };
    
    const showModal = (title, message, onConfirm) => setModal({ isOpen: true, title, message, onConfirm });
    const closeModal = () => setModal({ ...modal, isOpen: false });
    
    // **CORRECTED:** Wrapped in `useCallback` to be a stable prop
    const handleTradeMessage = useCallback((msg) => {
        setMessage(msg);
        setTimeout(() => setMessage(null), 2500); // Notification lasts 2.5s
    }, []);

    // --- 3D Drag Handlers ---
    const handleMouseMove = useCallback((e) => {
        if (!dragInfo.current) return;
        const { element, startX, startY } = dragInfo.current;
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        element.style.transform = `rotateX(${-deltaY * 0.2}deg) rotateY(${deltaX * 0.2}deg) scale3d(1.05, 1.05, 1.05)`;
    }, []);
    
    const handleMouseUp = useCallback(() => {
        if (!dragInfo.current) return;
        dragInfo.current.element.classList.remove('is-dragging');
        dragInfo.current.element.style.transform = ''; // Reset transform
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
        dragInfo.current = null;
    }, [handleMouseMove]);
    
    const handleMouseDown = useCallback((e) => {
        const tagsToIgnore = ['INPUT', 'TEXTAREA', 'LABEL', 'BUTTON', 'TEXTAREA', 'SELECT'];
        const classToIgnore = 'no-drag';
        // Check if target or any parent has the 'no-drag' class
        if (e.button !== 0 || tagsToIgnore.includes(e.target.tagName) || e.target.closest('label') || e.target.closest(`.${classToIgnore}`)) {
            return;
        }
        
        const element = e.currentTarget;
        element.classList.add('is-dragging');
        dragInfo.current = { element, startX: e.clientX, startY: e.clientY };
        
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }, [handleMouseMove, handleMouseUp]);
    
    // --- Memoized Calculations for UI ---
    
    // Analysis for the *active* month tab
    const analysis = useMemo(() => {
        if (!data || !data.months[activeMonthIndex]) return { pnl: 0, profitDays: 0, lossDays: 0, winningTrades: 0, losingTrades: 0 };
        
        const month = data.months[activeMonthIndex];
        const completedDays = month.days.filter(d => d.actual !== "");
        
        const pnl = completedDays.reduce((acc, day) => { const value = Number(day.actual) || 0; return acc + (day.pnlSign === '+' ? value : -value); }, 0);
        const profitDays = completedDays.filter(d => (d.pnlSign === '+' && d.actual !== '0' && d.actual !== '')).length;
        const lossDays = completedDays.filter(d => (d.pnlSign === '-' && d.actual !== '0' && d.actual !== '')).length;
        const winningTrades = completedDays.reduce((acc, day) => acc + (Number(day.winningTrades) || 0), 0);
        const losingTrades = completedDays.reduce((acc, day) => acc + (Number(day.losingTrades) || 0), 0);
        
        return { pnl, profitDays, lossDays, winningTrades, losingTrades };
    }, [data, activeMonthIndex]);
    
    // Starting capital for the *active* month tab
    const startCapitalForMonth = useMemo(() => {
        if (!data || !data.months[activeMonthIndex]) return data ? data.initialCapital : 0;
        if (activeMonthIndex === 0) return data.initialCapital;
        
        // Find the first day of the active month
        const firstDayOfActiveMonth = data.months[activeMonthIndex].days[0];
        return firstDayOfActiveMonth ? firstDayOfActiveMonth.capital : 0;
        
    }, [data, activeMonthIndex]);
    
    // --- Main Render ---
    useEffect(() => {
        // Toggle theme on the <html> element for Tailwind's `dark:` selectors
        document.documentElement.classList.toggle("dark", theme === "dark");
        document.documentElement.classList.toggle("bg-black", theme === "dark");
        document.documentElement.classList.toggle("bg-gray-100", theme !== "dark");
    }, [theme]);
            
    // Today's capital for the trader (use fallback)
    const tradingCapital = todayData ? todayData.capital : data.initialCapital;
    const currentMonthData = data.months[activeMonthIndex];
    
    return (
        <div className={`relative min-h-screen text-gray-800 dark:text-gray-200 flex flex-col items-center p-4 sm:p-6 scanlines transition-colors duration-500 ${theme}`}>
            <BubbleBackground theme={theme} />
            <Modal isOpen={modal.isOpen} title={modal.title} message={modal.message} onConfirm={modal.onConfirm} onCancel={closeModal} />
            
            {/* Trade Notification */}
            {message && (<div className={`fixed top-24 left-1/2 -translate-x-1/2 z-50 p-4 rounded-lg shadow-xl backdrop-blur-sm border ${message.isProfit ? 'bg-green-800/80 border-green-500 text-white' : 'bg-red-800/80 border-red-500 text-white'}`}>{message.text}</div>)}

            {/* Header / User Info */}
            <button onClick={toggleTheme} className="absolute top-4 right-4 sm:top-6 sm:right-6 px-4 py-2 rounded-lg bg-white/50 dark:bg-black/70 backdrop-blur-sm z-10">...</button>
            <div className="absolute top-4 left-4 sm:top-6 sm:left-6 z-10 flex gap-2 items-center">
                <div className="h-10 w-10 bg-cyan-500 rounded-full flex items-center justify-center text-white font-bold">{user.email ? user.email[0].toUpperCase() : 'U'}</div>
                <button onClick={onSignOut} className="text-xs text-gray-400 hover:text-white">Sign Out</button>
            </div>
            
            <header className="text-center w-full max-w-7xl z-10">
                <h1 className="text-2xl sm:text-4xl font-black mb-2 text-cyan-600 dark:text-cyan-400" style={{textShadow: '0 0 10px #00ffff'}}>DevTrader Trading Journal</h1>
                <p className="font-bold tracking-wider text-gray-500 dark:text-gray-300 mb-2 drop-shadow">OBJECTIVE: ₹{formatNumber(data.initialCapital, false)} → ₹{formatNumber(data.finalTarget, false)} in {data.tenure} days</p>
                <p className="text-xs text-gray-400">User: {user.email || user.uid}</p>
            </header>
            
            {/* Settings Panel */}
            <div className="w-full max-w-5xl my-4 p-4 z-10 bg-white/50 dark:bg-black/70 backdrop-blur-sm border border-cyan-700/30 dark:border-cyan-500/50 shadow-[0_0_15px_rgba(0,255,255,0.3)]">
                <div className="flex flex-col sm:flex-row justify-center items-center gap-4">
                    <div className="flex flex-col items-center">
                        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1">START CAPITAL</label>
                            <div className="flex items-center bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 focus-within:ring-2 focus-within:ring-cyan-400">
                                <span className="px-2 text-gray-500">₹</span>
                                <input type="number" value={inputCapital} onChange={e => setInputCapital(e.target.value)} className="bg-transparent text-center p-2 w-40 focus:outline-none" />
                            </div>
                    </div>
                    <div className="flex flex-col items-center">
                        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1">OVERALL TARGET</label>
                        <div className="flex items-center bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 focus-within:ring-2 focus-within:ring-cyan-400">
                            <span className="px-2 text-gray-500">₹</span>
                            <input type="number" value={inputTarget} onChange={e => setInputTarget(e.target.value)} className="bg-transparent text-center p-2 w-40 focus:outline-none" />
                        </div>
                    </div>
                        <div className="flex flex-col items-center">
                        <label className="text-xs text-gray-500 dark:text-gray-400 mb-1">TENURE (DAYS)</label>
                        <input type="number" value={inputTenure} onChange={e => setInputTenure(e.target.value)} className="bg-white/50 dark:bg-black/50 border border-cyan-700/30 dark:border-cyan-500/50 text-center p-2 w-48 focus:outline-none focus:ring-2 focus:ring-cyan-400" />
                    </div>
                        <button onClick={handleUpdateTargets} className="bg-cyan-600/80 hover:bg-cyan-500/80 border border-cyan-400 backdrop-blur-sm text-white px-6 py-2 mt-2 sm:mt-5 font-bold shadow-[0_0_10px_rgba(0,255,255,0.5)] transition-all">SET & RECALCULATE</button>
                </div>
            </div>
            
            {/* Demo Trader */}
            <div className="w-full max-w-7xl mb-4 z-10">
                <DemoTrader
                    onTradeClose={handleTradeClose}
                    theme={theme}
                    availableCapital={tradingCapital}
                    hiddenSymbols={data.hiddenSymbols || []}
                    onSymbolVisibilityChange={handleSymbolVisibilityChange}
                    onNewMessage={handleTradeMessage}
                />
            </div>

            {/* Month Tabs */}
            <div className="w-full max-w-7xl mb-4 bg-white/50 dark:bg-black/70 backdrop-blur-sm rounded-t-lg z-10 border-t border-x border-cyan-700/30 dark:border-cyan-500/50 shadow-[0_0_15px_rgba(0,255,255,0.3)]">
                <div className="flex overflow-x-auto">
                    {data.months.map((month, index) => (
                        <button key={month.id} onClick={() => setActiveMonthIndex(index)} className={`px-4 py-2 text-xs sm:text-sm font-bold transition-all whitespace-nowrap border-b-2 ${activeMonthIndex === index ? 'border-cyan-500 text-cyan-600 dark:border-cyan-400 dark:text-cyan-400' : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-cyan-600 dark:hover:text-cyan-400 hover:bg-cyan-900/20'}`}>
                            &gt; {month.monthName || `Month ${month.id}`}
                        </button>
                    ))}
                </div>
            </div>
            
            {/* Month Analysis */}
            <div className="w-full max-w-7xl grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-4 text-center z-10">
                {['MONTH P&L', 'PROFIT DAYS', 'LOSS DAYS', 'WINNING TRADES', 'LOSING TRADES', 'MONTH START'].map((title, i) => (
                    <div key={title} className="bg-white/50 dark:bg-black/70 backdrop-blur-sm p-4 border border-fuchsia-700/30 dark:border-fuchsia-500/50 shadow-[0_0_15px_rgba(255,0,255,0.3)]">
                        <h4 className="text-xs sm:text-sm font-semibold text-gray-500 dark:text-gray-400">{title}</h4>
                        <p className={`text-lg sm:text-xl font-bold ${
                            i === 0 ? (analysis.pnl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400') : 
                            i === 1 || i === 3 ? 'text-green-600 dark:text-green-400' : 
                            i === 2 || i === 4 ? 'text-red-600 dark:text-red-400' : 
                            'text-gray-800 dark:text-gray-200'
                        }`}>
                            {i === 0 ? `₹${formatNumber(analysis.pnl, false)}` : 
                             i === 1 ? analysis.profitDays : 
                             i === 2 ? analysis.lossDays : 
                             i === 3 ? analysis.winningTrades : 
                             i === 4 ? analysis.losingTrades : 
                             '₹' + formatNumber(Math.round(startCapitalForMonth), false) }
                        </p>
                    </div>
                ))}
            </div>

            {/* Journal Days List */}
            <div className="w-full max-w-7xl perspective-container z-10">
                <div className="space-y-6">
                    {currentMonthData && currentMonthData.days.map((row, i) => (
                        <JournalDay 
                            key={row.date} // Use date as key for stable memoization
                            row={row} 
                            activeMonthIndex={activeMonthIndex} 
                            i={i} 
                            todayString={todayString} 
                            handleMouseDown={handleMouseDown} 
                            handleDetailsChange={handleJournalChange} 
                            handleRuleChange={handleRuleChange} 
                            handleProfitInput={handleProfitInput} 
                            handleSignChange={handleSignChange} 
                        />
                    ))}
                </div>
            </div>
            
            {/* Footer Actions */}
            <div className="w-full max-w-7xl mt-6 flex flex-wrap justify-center gap-4 z-10">
                <button onClick={handleResetChallenge} className="bg-red-600/80 hover:bg-red-500/80 border border-red-400 backdrop-blur-sm text-white px-6 py-2 font-bold shadow-[0_0_10px_rgba(239,68,68,0.5)] transition-all">PURGE & RESET CHALLENGE</button>
            </div>
        </div>
    );
}

/**
 * Main App: Handles Auth and Data Loading
 */
export default function MainApp() {
    const [user, setUser] = useState(null); // Firebase auth user object
    const [userData, setUserData] = useState(null); // Firestore document data
    const [authLoading, setAuthLoading] = useState(true);
    const [dbLoading, setDbLoading] = useState(true);
    const [message, setMessage] = useState(null); // Global message handler

    // 1. Handle Auth State
    useEffect(() => {
        if (!auth) {
            console.error("Firebase Auth is not initialized.");
            setAuthLoading(false);
            return;
        }
        
        // **CORRECTED:** Use environment token or anonymous sign-in
        const initialAuth = async () => {
            try {
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (e) {
                console.error("Error during initial authentication:", e);
                // Even if auth fails, stop loading to show login
                setAuthLoading(false);
            }
        };

        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                console.log("Auth state change: User signed in:", user.uid);
                setUser(user);
            } else {
                console.log("Auth state change: User signed out.");
                setUser(null);
                setUserData(null); // Clear data on sign out
                
                // **CORRECTED:** Try to sign in again if user signs out
                // (e.g., token expired). This keeps them in the app.
                // Comment this out if you want to force them to the login screen.
                await initialAuth(); 
            }
            setAuthLoading(false);
        });

        // Trigger initial auth check
        initialAuth();

        return () => unsubscribe();
    }, []);

    // 2. Handle Firestore Data Loading (when user is known)
    useEffect(() => {
        if (user) {
            setDbLoading(true);
            const userDocRef = doc(db, `artifacts/${appId}/users/${user.uid}/journal/data`);
            
            const unsubscribe = onSnapshot(userDocRef, (doc) => {
                if (doc.exists()) {
                    console.log("User data found.");
                    setUserData(doc.data());
                } else {
                    console.log("No user data. Creating new journal...");
                    // Create a new journal
                    createNewJournal(userDocRef);
                    // Set temporary data so we don't flash the loading screen
                    const initialTenure = DEFAULT_TENURE_DAYS;
                    const months = generatePlanStructure(initialTenure);
                    let tempData = { initialCapital: DEFAULT_INITIAL_CAPITAL, finalTarget: DEFAULT_FINAL_TARGET, tenure: initialTenure, months: months, hiddenSymbols: [] };
                    setUserData(tempData); // This is temporary until the `setDoc` triggers snapshot
                }
                setDbLoading(false);
            }, (error) => {
                console.error("Firestore snapshot error:", error);
                setDbLoading(false);
            });
            
            return () => unsubscribe();
        } else {
            // No user, no data
            setDbLoading(false);
        }
    }, [user]); // Re-run when user object changes
    
    // Helper to create the initial journal
    const createNewJournal = async (userDocRef) => {
        try {
            const initialTenure = DEFAULT_TENURE_DAYS;
            const months = generatePlanStructure(initialTenure); // Use hoisted func
            let initialData = {
                initialCapital: DEFAULT_INITIAL_CAPITAL,
                finalTarget: DEFAULT_FINAL_TARGET,
                tenure: initialTenure, months: months,
                hiddenSymbols: [], version: 2
            };
            initialData.months = recalculatePlan(initialData); // Use hoisted func
            await setDoc(userDocRef, initialData);
            console.log("New journal created.");
            // The onSnapshot listener will pick up this change and set state
        } catch (error) { console.error("Error creating new journal:", error); }
    };
    
    // --- Render Logic ---
    
    if (authLoading || !appId || appId === 'default-app-id') {
        // Show loading if auth is happening or if appId isn't loaded
        return (
            <div className="dark bg-black min-h-screen flex items-center justify-center">
                <BubbleBackground theme="dark" />
                <div className="text-cyan-400 text-2xl font-black z-10" style={{textShadow: '0 0 10px #00ffff'}}>
                    INITIALIZING...
                </div>
            </div>
        );
    }
    
    return (
        <div className="dark bg-black min-h-screen">
            {/* Global Notification Handler */}
            {message && (<div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] p-4 rounded-lg shadow-xl backdrop-blur-sm border ${message.isProfit ? 'bg-green-800/80 border-green-500 text-white' : 'bg-red-800/80 border-red-500 text-white'}`}>{message.text}</div>)}
            
            {!user ? (
                // 1. User is Signed Out (and initial auth failed)
                <AuthComponent />
            ) : (dbLoading || !userData) ? (
                // 2. User is Signed In, but data is loading
                <div className="dark bg-black min-h-screen flex items-center justify-center">
                    <BubbleBackground theme="dark" />
                    <div className="text-cyan-400 text-2xl font-black z-10" style={{textShadow: '0 0 10px #00ffff'}}>
                        LOADING JOURNAL...
                    </div>
                </div>
            ) : (
                // 3. User is Signed In and data is loaded
                <JournalAppComponent
                    user={user}
                    userData={userData}
                    onSignOut={() => signOut(auth)} // Allow manual sign-out
                />
            )}
        </div>
    );
}
