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
        return res
            .status(400)
            .json({ error: 'Parameter wallet_id is required' });
    }

    try {
        // --- 1) Собираем все входящие NFT-трансферы
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
            const batch = json.nft_transfers;               // <-- раньше здесь был transfers
            if (!Array.isArray(batch) || batch.length === 0) break;
            allTransfers = allTransfers.concat(batch);
            if (batch.length < limit) break;
        }

        // --- 2) Получаем «репутацию» по всем полученным NFT
        const repUrl  = new URL(REPUTATION_URL);
        repUrl.searchParams.set('owner', walletId);
        const repResp = await fetch(repUrl.toString());
        if (!repResp.ok) throw new Error(`Reputation API ${repResp.status}`);
        const repJson = await repResp.json();

        // приводим к { token_id: reputation }
        const repMap = {};
        const records = repJson.reputation_records;
        if (Array.isArray(records) && records.length > 0) {
            const rec = records[0];
            // из трёх массивов «item» вытаскиваем token_id и reputation
            ['horse_items', 'volga_items', 'reputation_nfts'].forEach(cat => {
                if (Array.isArray(rec[cat])) {
                    rec[cat].forEach(item => {
                        repMap[item.token_id] = item.reputation;
                    });
                }
            });
            // если нужно включить ещё какие-то категории — просто добавьте их в список выше
        }

        // --- 3) Группируем по отправителю и суммируем репутации
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from = tx.sender_id;                       // <-- в ответе поле называется sender_id
            const token = tx.args?.token_id ?? tx.token_id; // на всякий случай
            const rep   = repMap[token] || 0;
            acc[from]  = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // --- 4) Собираем и сортируем лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
