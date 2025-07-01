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
    const debug    = req.query.debug === 'true';

    // парсим и валидируем start_time/end_time
    let startNano = null, endNano = null;
    if (req.query.start_time) {
        const d = Date.parse(req.query.start_time);
        if (!Number.isNaN(d)) startNano = BigInt(d) * 1_000_000n;
    }
    if (req.query.end_time) {
        const d = Date.parse(req.query.end_time);
        if (!Number.isNaN(d)) endNano = BigInt(d) * 1_000_000n;
    }

    if (!walletId) {
        return res.status(400).json({ error: 'Parameter wallet_id is required' });
    }

    try {
        // 1) стягиваем и фильтруем трансферы
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

        // 2) собираем сет токенов
        const transferredTokenIds = new Set(
            allTransfers.map(tx => String(tx.args?.token_id ?? tx.token_id))
        );

        // 3) запрашиваем репутации
        let repMap = {};
        let repStatus = null;
        let repJson   = null;
        try {
            const ru      = new URL(REPUTATION_URL);
            ru.searchParams.set('owner', walletId);
            const rr     = await fetch(ru.toString());
            repStatus    = rr.status;
            if (rr.ok) {
                repJson = await rr.json();
                const recs = Array.isArray(repJson.reputation_records)
                    ? repJson.reputation_records
                    : [];
                if (recs.length > 0) {
                    // динамически проходим по всем массивам внутри rec
                    const rec = recs[0];
                    for (const [key, arr] of Object.entries(rec)) {
                        if (!Array.isArray(arr)) continue;
                        arr.forEach(item => {
                            if (item.token_id != null && typeof item.reputation === 'number') {
                                const tid = String(item.token_id);
                                if (transferredTokenIds.has(tid)) {
                                    repMap[tid] = item.reputation;
                                }
                            }
                        });
                    }
                }
            }
        } catch (e) {
            console.warn('Error fetching reputation:', e);
        }

        // 4) группируем и суммируем
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from = tx.sender_id;
            const tid  = String(tx.args?.token_id ?? tx.token_id);
            const rep  = repMap[tid] || 0;
            acc[from]   = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 5) формируем лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        // 6) отдаём debug-инфу, если нужно
        if (debug) {
            return res.status(200).json({
                leaderboard,
                debug: {
                    transferredTokenIds: Array.from(transferredTokenIds),
                    repStatus,
                    repJson,
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
