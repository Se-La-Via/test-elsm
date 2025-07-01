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

    // парсим опциональный интервал
    let startNano = null, endNano = null;
    if (req.query.start_time) {
        const d = Date.parse(req.query.start_time);
        if (!Number.isNaN(d)) startNano = BigInt(d) * 1_000_000n;
    }
    if (req.query.end_time) {
        const d = Date.parse(req.query.end_time);
        if (!Number.isNaN(d)) endNano = BigInt(d) * 1_000_000n;
    }

    try {
        // 1) стягиваем трансферы
        let allTransfers = [];
        for (let offset = skip; ; offset += limit) {
            const url = new URL(TRANSFERS_URL);
            url.searchParams.set('wallet_id', walletId);
            url.searchParams.set('direction', 'in');
            url.searchParams.set('limit',  String(limit));
            url.searchParams.set('skip',   String(offset));

            const resp = await fetch(url.toString());
            if (!resp.ok) break;
            const { nft_transfers: batch } = await resp.json();
            if (!Array.isArray(batch) || batch.length === 0) break;

            // 2) фильтруем по дате, если нужно
            const filtered = batch.filter(tx => {
                if (startNano === null && endNano === null) return true;
                if (!tx.timestamp_nanosec) return false;
                const ts = BigInt(tx.timestamp_nanosec);
                if (startNano !== null && ts < startNano) return false;
                if (endNano   !== null && ts > endNano)   return false;
                return true;
            });

            allTransfers.push(...filtered);
            if (batch.length < limit) break;
        }

        // 3) собираем репутации из всех записей
        const repResp = await fetch(REPUTATION_URL);
        const repMap  = {};
        if (repResp.ok) {
            const repJson = await repResp.json();
            const allRecs = Array.isArray(repJson.reputation_records)
                ? repJson.reputation_records
                : [];
            for (const rec of allRecs) {
                for (const arr of Object.values(rec)) {
                    if (!Array.isArray(arr)) continue;
                    for (const item of arr) {
                        if (item.token_id != null && typeof item.reputation === 'number') {
                            repMap[String(item.token_id)] = item.reputation;
                        }
                    }
                }
            }
        } else {
            console.warn(`Reputation API returned ${repResp.status}, skipping reputations`);
        }

        // 4) группируем по отправителю и суммируем
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from = tx.sender_id;
            const tid  = String(tx.args?.token_id ?? tx.token_id);
            const rep  = repMap[tid] || 0;
            acc[from] = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 5) форматируем результат
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
