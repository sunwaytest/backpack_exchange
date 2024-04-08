"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const backpack_client_1 = require("./backpack_client");
const { checkbox, input } = require('@inquirer/prompts');
const { tokenList } = require('./token');
// In your code, 默认从根目录开始算的
require('dotenv').config({path: 'config/.env'});

function delay(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

//当前年份日期时分秒
function getNowFormatDate() {
    var date = new Date();
    var seperator1 = "-";
    var seperator2 = ":";
    var month = date.getMonth() + 1;
    var strDate = date.getDate();
    var strHour = date.getHours();
    var strMinute = date.getMinutes();
    var strSecond = date.getSeconds();
    if (month >= 1 && month <= 9) {
        month = "0" + month;
    }
    if (strDate >= 0 && strDate <= 9) {
        strDate = "0" + strDate;
    }
    if (strHour >= 0 && strHour <= 9) {
        strHour = "0" + strHour;
    }
    if (strMinute >= 0 && strMinute <= 9) {
        strMinute = "0" + strMinute;
    }
    if (strSecond >= 0 && strSecond <= 9) {
        strSecond = "0" + strSecond;
    }
    var currentdate = date.getFullYear() + seperator1 + month + seperator1 + strDate
        + " " + strHour + seperator2 + strMinute
        + seperator2 + strSecond;
    return currentdate;
}

//返回小数位
function countDecimalPlaces(number) {
    let decimalPart = String(number).match(/\.(\d*)/);
    return decimalPart ? decimalPart[1].length : 0;
}

//网格交易的参数
let meshNum = 10;
let meshLowPrice = 0;
let meshHighPrice = 0;
let priceGap = 0;
let meshQuitPercent = 0.05; //当价格超过上下限多少的时候 退出网格
let investMoney = 0;
let lineValue = 0;
let targetToken = "WEN";
let targetPair = "WEN_USDC";
let priceNearlyEqualRatio = 0.001;
//生成网格线数组
let meshState;

let successbuy = 0;
let sellbuy = 0;

function printMeshParams() {
    console.log("交易对: ", targetPair)
    console.log("网格最低价: ", meshLowPrice);
    console.log("网格最高价: ", meshHighPrice);
    console.log("网格数目: ", meshNum);
    console.log("每隔的价格差: ", priceGap);
    console.log("总投入金额: ", investMoney);
    console.log("每格金额: ", lineValue)
}

async function paramCheck(client) {
    if (meshHighPrice <= meshLowPrice) {
        console.log("ERROR: 最高价 <= 最低价!")
        return false;
    }

    //否则后面的余额查询会报错
    await client.Markets();
    let userbalance = await client.Balance();
    if (userbalance.USDC.available < investMoney) {
        console.log("ERROR: 余额不足！", userbalance.USDC.available, investMoney)
        return false;
    }

    return true;
}

//价格相差千分之一， 就认为可以相等
function checkPriceNearlyEqual(marketPrice, linePrice) {
    return Math.abs( marketPrice - linePrice ) / linePrice < priceNearlyEqualRatio;
}

const init = async (client, lowPrice, highPrice, num, money) => {
    meshLowPrice = Number(lowPrice, 10);
    meshHighPrice = Number(highPrice, 10);
    meshNum = Number(num, 10);
    investMoney = Number(money, 10);
    let paramCheckResult = await paramCheck(client);
    if (!paramCheckResult) {
        console.log("参数校验失败, 请重新输入!")
        return;
    }

    priceGap = (highPrice - lowPrice) / meshNum;
    lineValue = investMoney / meshNum;
    meshState = new Array(meshNum).fill().map((_, i) => ({ lineIdx: i, linePrice: meshLowPrice + priceGap * (i), hasPosition: false, lineValue: lineValue}));
    //console.log(meshState)
    console.log(getNowFormatDate(), "初始化完成, 参数如下：");
    printMeshParams();

    //这句一定要
    let markets = await client.Markets();
    //允许购买的token的最小单位的小数点有几位
    let tokensDecimal = {};
    //token 最小交易小数位
    markets.forEach((market) => {
        tokensDecimal[market.symbol] = countDecimalPlaces(market.filters.quantity.minQuantity);
    });

    //主循环
    while (true) {
        try {
            console.log("=================================================")
            console.log(`成功买入次数:${successbuy},成功卖出次数:${sellbuy}`);
            await delay(2 * 1000);
            
            //获取当前token的价格， 看下在哪个区间
            let { lastPrice: lastPriceAsk } = await client.Ticker({ symbol: targetPair });
            console.log(getNowFormatDate(), `${targetPair}的市场当前价格:`, lastPriceAsk);

            if (lastPriceAsk < meshLowPrice * (1 - meshQuitPercent) ||
                lastPriceAsk > meshHighPrice * (1 + meshQuitPercent)) {
                console.log("============== Need Quit ===================")
                return;
            }

            let meshIdx = Math.floor((lastPriceAsk - meshLowPrice) / priceGap);
            console.log("current mesh index: ", meshIdx)

            //如果下面那根网格线持有仓位，则优先进行平仓操作
            if (meshIdx >= 1) {
                let meshIdxBelow = meshIdx - 1;
                if (meshState[meshIdxBelow].hasPosition) {
                    await sellfun(client, meshIdxBelow, tokensDecimal, lastPriceAsk);
                } else {
                    console.log("mesh below donesn't have position, index: ", meshIdxBelow);
                }
            }

            //如果当前网格线没有仓位，则进行开仓操作
            if (meshIdx >= 0 && meshIdx < meshState.length) {
                //检查价格是否达到网格线,要求近似相等
                let linePrice = meshState[meshIdx].linePrice;
                if (checkPriceNearlyEqual(lastPriceAsk, linePrice)) {
                    if (!meshState[meshIdx].hasPosition) {
                        await buyfun(client, meshIdx, tokensDecimal, lastPriceAsk);
                    }
                    else {
                        console.log("current line already has position! meshIdx: ", meshIdx)
                    }
                } else {
                    console.log(`Skip: price gap too big, market price: ${lastPriceAsk}, line price: ${linePrice}`);
                }
            }
        } catch (e) {
            console.log(getNowFormatDate(), "IOC 挂单失败,重新挂单中...");
            //console.log(e);
            await delay(1000);
        }
    } // end while
}

//后面对接其他平台，只需要修改sell 和 buy的接口
const sellfun = async (client, meshIdxBelow, tokensDecimal, lastPriceAsk) => {
    //取消所有未完成订单，因为订单挂的是IOC模式的
    let GetOpenOrders = await client.GetOpenOrders({ symbol: targetPair });
    if (GetOpenOrders.length > 0) {
        await client.CancelOpenOrders({ symbol: targetPair });
        console.log(getNowFormatDate(), "取消了所有挂单");
    } else {
        console.log(getNowFormatDate(), "账号订单正常，无需取消挂单");
    }

    if (meshIdxBelow < 0 || meshIdxBelow >= meshState.length) {
        console.log("ERROR: 卖出函数越界!")
        return;
    }
    let lineObj = meshState[meshIdxBelow];
    let quantitys = ((lineObj["lineValue"]) / lineObj["linePrice"]).toFixed(tokensDecimal[targetToken]).toString();

    console.log(getNowFormatDate(), `正在卖出中... 卖${quantitys}个${targetToken}`);

    let buyPriceStr = lastPriceAsk.toString();
    console.log(quantitys, typeof(quantitys));
    console.log(buyPriceStr, typeof(buyPriceStr));

    let orderResultAsk = await client.ExecuteOrder({
        orderType: "Limit",
        price: buyPriceStr,
        postOnly: false,
        quantity: quantitys,
        side: "Ask", //卖
        symbol: targetPair,
        timeInForce: "IOC"
    })
    
    if (orderResultAsk?.status == "Filled" && orderResultAsk?.side == "Ask") {
        //仓位标志成 空
        lineObj.hasPosition = false;
        console.log(getNowFormatDate(), "卖出成功");
        sellbuy += 1;
        console.log(getNowFormatDate(), "订单详情:", `卖出价格:${orderResultAsk.price}, 卖出数量:${orderResultAsk.quantity}, 订单号:${orderResultAsk.id}`);
        //throw new Error("卖出成功、程序重新执行");
    } else {
        console.log(getNowFormatDate(), "IOC 卖出失败");
        throw new Error("IOC 卖出失败");
    }
}

// 买入, 通过money变量的比例用USDC买入token
const buyfun = async (client, meshIdx, tokensDecimal, lastPriceAsk) => {
    //取消所有未完成订单
    let GetOpenOrders = await client.GetOpenOrders({ symbol: targetPair });
    if (GetOpenOrders.length > 0) {
        await client.CancelOpenOrders({ symbol: targetPair });
        console.log(getNowFormatDate(), "取消了所有挂单");
    } else {
        console.log(getNowFormatDate(), "账号订单正常，无需取消挂单");
    }

    if (meshIdx < 0 || meshIdx >= meshState.length) {
        console.log("ERROR: 买入函数越界!")
        return;
    }
    let lineObj = meshState[meshIdx];    
    console.log(targetToken,'小数位',tokensDecimal[targetPair]);
    
    //console.log(getNowFormatDate(), `正在买入中... 花${(lineObj["lineValue"]).toFixed(tokensDecimal[targetPair]).toString()}个USDC买${targetToken}`);
    let quantitys = ((lineObj["lineValue"]) / lineObj["linePrice"]).toFixed(tokensDecimal[targetPair]).toString();
    console.log(getNowFormatDate(), `正在买入中... 花${(lineObj["lineValue"]).toString()}个USDC买${quantitys}个 ${targetToken}`);

    let buyPriceStr = lastPriceAsk.toString();
    console.log(buyPriceStr, typeof(buyPriceStr));
    console.log(quantitys, typeof(quantitys));
    console.log(targetPair)

    let orderResultBid = await client.ExecuteOrder({
        orderType: "Market",
        //price: buyPriceStr,
        quantity: quantitys,
        side: "Bid", //buy
        symbol: targetPair,
        timeInForce: "IOC" // Good Till Cancelled (GTC), Immediate or Cancel (IOC), Full Fill or Kill (FOK)
    })

    if (orderResultBid?.status == "Filled" && orderResultBid?.side == "Bid") {
        //修改仓位状态
        lineObj.hasPosition = true;
        console.log(getNowFormatDate(), "买入成功");
        successbuy += 1;
        console.log(getNowFormatDate(), "订单详情:", `购买价格:${orderResultBid.price}, 购买数量:${orderResultBid.quantity}, 订单号:${orderResultBid.id}`);
        //throw new Error("买入成功、程序重新执行");
    } else {
        console.log(getNowFormatDate(), "IOC 买入失败");
        throw new Error("买入失败");
    }
}

//用户输入预设参数
(async () => {
    const tokenAnswer = await checkbox(tokenList); //币种列表
    if (tokenAnswer.length == 0) {
        console.log("未选择币种，退出");
        return;
    }
    console.log("已选", tokenAnswer);

    const lowPrice = await input({
        message: '请输入最低价(单位:u): ',
        validate: function(valueString) {
            let value = Number(valueString, 10);
            if (!isNaN(value)) {
                return true;
            }
            return '请输入正确的数字 (例如: "180") !';
        }
    });
    console.log("Low price: ", lowPrice)

    const highPrice = await input({
        message: '请输入最高价(单位: u): ',
        validate: function(valueString) {
            let value = Number(valueString, 10);
            if (!isNaN(value)) {
                return true;
            }
            return '请输入正确的数字 (例如: "160") !';
        }
    });
    console.log("High price: ", highPrice);

    let integerReg = /^\d+$/;
    const meshNum = await input({
        message: '请输入网格数目: ',
        validate: function(value) {
            const pass = integerReg.test(value);
            if (pass) {
                return true;
            }
            return '请输入正确的数字 (例如: "160") !';
        }
    });
    console.log("mesh num: ", meshNum);

    const investMoney = await input({
        message: '请输入投入总金额(单位: u): ',
        validate: function(valueString) {
            let value = Number(valueString, 10);
            if (!isNaN(value)) {
                return true;
            }
            return '请输入正确的数字 (例如: "1000") !';
        }
    });
    console.log("Invest money: ", investMoney);

    //函数主入口
    const apisecret =  process.env.API_SECRET;
    const apikey = process.env.API_KEY;
    const client = new backpack_client_1.BackpackClient(apisecret, apikey);
    init(client, lowPrice, highPrice, meshNum, investMoney);
})();
