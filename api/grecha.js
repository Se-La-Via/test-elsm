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

    // Опциональные параметры фильтрации по времени
    // Ожидаются в ISO-формате, например "2025-06-01T00:00:00Z"
    const startTime = req.query.start_time
        ? Date.parse(req.query.start_time)
        : null;
    const endTime = req.query.end_time
        ? Date.parse(req.query.end_time)
        : null;

    // Переводим из мс в нс для сравнения с timestamp_nanosec
    const startNano = startTime != null ? startTime * 1e6 : null;
    const endNano   = endTime   != null ? endTime * 1e6   : null;

    if (!walletId) {
        return res
            .status(400)
            .json({ error: 'Parameter wallet_id is required' });
    }

    try {
        // 1) Собираем все входящие NFT-трансферы по батчам
        let allTransfers = [];
        for (let offset = skip; ; offset += limit) {
            const url = new URL(TRANSFERS_URL);
            url.searchParams.set('wallet_id', walletId);
            url.searchParams.set('direction', 'in');
            url.searchParams.set('limit', limit);
            url.searchParams.set('skip', offset);

            const response = await fetch(url.toString());
            if (!response.ok) break;
            const json = await response.json();
            const batch = json.nft_transfers;
            if (!Array.isArray(batch) || batch.length === 0) break;

            // 2) Фильтруем по времени, если заданы границы
            const filtered = batch.filter(tx => {
                const ts = Number(tx.timestamp_nanosec);
                if (startNano !== null && ts < startNano) return false;
                if (endNano   !== null && ts > endNano)   return false;
                return true;
            });

            allTransfers = allTransfers.concat(filtered);
            if (batch.length < limit) break;
        }

        // 3) Собираем множество token_id реально пришедших транзакций
        const transferredTokenIds = new Set(
            allTransfers.map(tx =>
                (tx.args && tx.args.token_id) || tx.token_id
            )
        );

        // 4) Получаем репутацию для всех NFT у владельца
        const repUrl  = new URL(REPUTATION_URL);
        repUrl.searchParams.set('owner', walletId);
        const repResp = await fetch(repUrl.toString());
        if (!repResp.ok) {
            throw new Error(`Reputation API error: ${repResp.status}`);
        }
        const repJson = await repResp.json();

        // 5) Формируем map token_id → reputation (только для отфильтрованных токенов)
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

        // 6) Группируем по отправителю и суммируем репутации
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from  = tx.sender_id;
            const tid   = (tx.args && tx.args.token_id) || tx.token_id;
            const rep   = repMap[tid] || 0;
            acc[from]   = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 7) Формируем и сортируем итоговый лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
