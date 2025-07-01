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

    // --- парсим и валидируем start_time / end_time
    let startNano = null;
    if (req.query.start_time) {
        const parsed = Date.parse(req.query.start_time);
        if (!Number.isNaN(parsed)) {
            startNano = BigInt(parsed) * 1_000_000n;
        }
    }
    let endNano = null;
    if (req.query.end_time) {
        const parsed = Date.parse(req.query.end_time);
        if (!Number.isNaN(parsed)) {
            endNano = BigInt(parsed) * 1_000_000n;
        }
    }

    if (!walletId) {
        return res.status(400).json({ error: 'Parameter wallet_id is required' });
    }

    try {
        // 1) Скачиваем NFT-трансферы батчами и фильтруем по дате
        let allTransfers = [];
        for (let offset = skip; ; offset += limit) {
            const u = new URL(TRANSFERS_URL);
            u.searchParams.set('wallet_id', walletId);
            u.searchParams.set('direction',  'in');
            u.searchParams.set('limit',      String(limit));
            u.searchParams.set('skip',       String(offset));

            const r = await fetch(u.toString());
            if (!r.ok) break;
            const { nft_transfers: batch } = await r.json();
            if (!Array.isArray(batch) || batch.length === 0) break;

            const filtered = batch.filter(tx => {
                // если нет фильтра по датам — берём всё
                if (startNano === null && endNano === null) return true;
                if (!tx.timestamp_nanosec) return false;
                const ts = BigInt(tx.timestamp_nanosec);
                if (startNano !== null && ts < startNano) return false;
                if (endNano   !== null && ts > endNano)   return false;
                return true;
            });

            allTransfers = allTransfers.concat(filtered);
            if (batch.length < limit) break;
        }

        // 2) Собираем сет строковых token_id, которые реально попали
        const transferredTokenIds = new Set(
            allTransfers.map(tx => String(tx.args?.token_id ?? tx.token_id))
        );

        // 3) Запрашиваем репутацию и собираем динамически из любых массивов
        let repMap = {};
        try {
            const ru = new URL(REPUTATION_URL);
            ru.searchParams.set('owner', walletId);
            const repResp = await fetch(ru.toString());
            if (repResp.ok) {
                const repJson = await repResp.json();
                const records = Array.isArray(repJson.reputation_records)
                    ? repJson.reputation_records
                    : [];
                if (records.length > 0) {
                    const rec = records[0];
                    // обходим все ключи объекта rec
                    for (const [k, arr] of Object.entries(rec)) {
                        if (!Array.isArray(arr)) continue;
                        for (const item of arr) {
                            // интересуют только те элементы, у которых есть token_id и reputation
                            if (item.token_id != null && typeof item.reputation === 'number') {
                                const tid = String(item.token_id);
                                if (transferredTokenIds.has(tid)) {
                                    repMap[tid] = item.reputation;
                                }
                            }
                        }
                    }
                }
            } else {
                console.warn(`Reputation API returned ${repResp.status}, skipping reputations`);
            }
        } catch (e) {
            console.warn('Error fetching reputation:', e);
        }

        // 4) Группируем по отправителю и суммируем
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from = tx.sender_id;
            const tid  = String(tx.args?.token_id ?? tx.token_id);
            const rep  = repMap[tid] || 0;
            acc[from]   = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 5) Формируем и сортируем лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        // 6) debug-mode?
        if (req.query.debug === 'true') {
            return res.status(200).json({
                leaderboard,
                debug: {
                    transferredTokenIds: Array.from(transferredTokenIds),
                    repMap
                }
            });
        }

        // 7) обычный ответ
        return res.status(200).json({ leaderboard });

    } catch (err) {
        console.error('Unexpected error:', err);
        return res.status(500).json({ error: err.message });
    }
}
