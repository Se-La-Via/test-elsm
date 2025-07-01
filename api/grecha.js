// api/nft-reputation.js
import fetch from 'node-fetch';

const TRANSFERS_URL   = 'https://dialog-tbot.com/history/nft-transfers/';
const REPUTATION_URL  = 'https://dialog-tbot.com/reputation/';
const DEFAULT_LIMIT   = 200;
const DEFAULT_SKIP    = 0;

export default async function handler(req, res) {
    const walletId = req.query.wallet_id;
    const limit    = Number(req.query.limit) || DEFAULT_LIMIT;
    const skip     = Number(req.query.skip)  || DEFAULT_SKIP;

    if (!walletId) {
        return res.status(400).json({ error: 'Parameter wallet_id is required' });
    }

    try {
        // 1) Собираем все входящие NFT-трансферы
        let allTransfers = [];
        for (let offset = skip; ; offset += limit) {
            const url = new URL(TRANSFERS_URL);
            url.searchParams.set('wallet_id', walletId);
            url.searchParams.set('direction', 'in');
            url.searchParams.set('limit', limit);
            url.searchParams.set('skip', offset);

            const r = await fetch(url.toString());
            if (!r.ok) break;
            const json = await r.json();
            const batch = json.nft_transfers;
            if (!Array.isArray(batch) || batch.length === 0) break;
            allTransfers = allTransfers.concat(batch);
            if (batch.length < limit) break;
        }

        // 2) Собираем множество токенов, которые реально пришли на кошелёк
        const transferredTokenIds = new Set(
            allTransfers.map(tx => (tx.args && tx.args.token_id) || tx.token_id)
        );

        // 3) Получаем «репутацию» только для этих токенов
        const repUrl  = new URL(REPUTATION_URL);
        repUrl.searchParams.set('owner', walletId);
        const repResp = await fetch(repUrl.toString());
        if (!repResp.ok) throw new Error(`Reputation API ${repResp.status}`);
        const repJson = await repResp.json();

        // Формируем map: token_id → reputation
        const repMap = {};
        const records = Array.isArray(repJson.reputation_records)
            ? repJson.reputation_records
            : [];
        if (records.length > 0) {
            const rec = records[0];
            ['horse_items', 'volga_items', 'reputation_nfts'].forEach(cat => {
                if (!Array.isArray(rec[cat])) return;
                rec[cat].forEach(item => {
                    const tid = item.token_id;
                    if (transferredTokenIds.has(tid)) {
                        repMap[tid] = item.reputation;
                    }
                });
            });
        }

        // 4) Группируем по отправителю и суммируем репутации
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from  = tx.sender_id;
            const token = (tx.args && tx.args.token_id) || tx.token_id;
            const rep   = repMap[token] || 0;
            acc[from]   = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 5) Формируем и возвращаем отсортированный лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
