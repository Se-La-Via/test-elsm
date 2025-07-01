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

    // Опциональные параметры фильтрации по времени (ISO-строки)
    const startTime = req.query.start_time
        ? Date.parse(req.query.start_time)
        : null;
    const endTime = req.query.end_time
        ? Date.parse(req.query.end_time)
        : null;

    // Переводим мс → нс и в BigInt для точных сравнений
    const startNano = startTime != null
        ? BigInt(startTime) * 1_000_000n
        : null;
    const endNano = endTime != null
        ? BigInt(endTime) * 1_000_000n
        : null;

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

            // 2) Фильтруем по timestamp_nanosec
            const filtered = batch.filter(tx => {
                const ts = BigInt(tx.timestamp_nanosec);
                if (startNano !== null && ts < startNano) return false;
                if (endNano   !== null && ts > endNano)   return false;
                return true;
            });

            allTransfers = allTransfers.concat(filtered);
            if (batch.length < limit) break;
        }

        // 3) Собираем множество реальных token_id
        const transferredTokenIds = new Set(
            allTransfers.map(tx => (tx.args?.token_id) || tx.token_id)
        );

        // 4) Получаем все репутационные записи
        const repUrl  = new URL(REPUTATION_URL);
        repUrl.searchParams.set('owner', walletId);
        const repResp = await fetch(repUrl.toString());
        if (!repResp.ok) throw new Error(`Reputation API error: ${repResp.status}`);
        const repJson = await repResp.json();

        // 5) Формируем map token_id → reputation (только для отфильтрованных)
        const repMap = {};
        const records = Array.isArray(repJson.reputation_records)
            ? repJson.reputation_records
            : [];
        if (records.length > 0) {
            const rec = records[0];
            ['horse_items', 'volga_items', 'reputation_nfts'].forEach(cat => {
                (rec[cat] || []).forEach(item => {
                    if (transferredTokenIds.has(item.token_id)) {
                        repMap[item.token_id] = item.reputation;
                    }
                });
            });
        }

        // 6) Группируем по отправителю и суммируем репутации
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from = tx.sender_id;
            const tid  = (tx.args?.token_id) || tx.token_id;
            const rep  = repMap[tid] || 0;
            acc[from]  = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 7) Сортируем и возвращаем лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
