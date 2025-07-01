// api/nft-reputation.js
import fetch from 'node-fetch';

const TRANSFERS_URL  = 'https://dialog-tbot.com/history/nft-transfers/';
const REPUTATION_URL = 'https://dialog-tbot.com/reputation/';
const DEFAULT_LIMIT  = 200;
const DEFAULT_SKIP   = 0;

export default async function handler(req, res) {
    const walletId = req.query.wallet_id;
    const limit    = Number(req.query.limit) || DEFAULT_LIMIT;
    const skip     = Number(req.query.skip)  || DEFAULT_SKIP;

    if (!walletId) {
        return res.status(400).json({ error: 'Parameter wallet_id is required' });
    }

    try {
        // 1) Собираем все входящие трансферы
        let allTransfers = [];
        for (let s = skip; ; s += limit) {
            const url = new URL(TRANSFERS_URL);
            url.searchParams.set('wallet_id', walletId);
            url.searchParams.set('direction', 'in');
            url.searchParams.set('limit', limit);
            url.searchParams.set('skip', s);

            const r = await fetch(url.toString());
            if (!r.ok) break;
            const { transfers } = await r.json();
            if (!transfers || transfers.length === 0) break;
            allTransfers = allTransfers.concat(transfers);
            if (transfers.length < limit) break;
        }

        // 2) Получаем репутации и приводим к мапе token_id → reputation
        const repUrl  = new URL(REPUTATION_URL);
        repUrl.searchParams.set('owner', walletId);
        const repResp = await fetch(repUrl.toString());
        if (!repResp.ok) throw new Error(`Reputation API ${repResp.status}`);
        const repData = await repResp.json();

        let repMap = {};
        if (Array.isArray(repData)) {
            for (const item of repData) {
                repMap[item.token_id] = item.reputation;
            }
        } else if (repData && typeof repData === 'object') {
            repMap = repData;
        }

        // 3) Группируем по отправителю и суммируем репутации
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from = tx.from;
            const rep  = repMap[tx.token_id] || 0;
            acc[from] = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 4) Формируем и возвращаем отсортированный лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
