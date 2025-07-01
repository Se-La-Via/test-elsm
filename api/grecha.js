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

    // парсим диапазон дат (опционально)
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
        // 1) Собираем все входящие NFT-трансферы в заданном периоде
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

            const filtered = batch.filter(tx => {
                // если нет фильтра по датам — берём всё
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

        // 2) Собираем уникальные token_id
        const tokenIds = Array.from(new Set(
            allTransfers.map(tx => String(tx.args?.token_id ?? tx.token_id))
        ));

        // 3) Bulk-запрос: получаем все репутации разом
        const repMap = {};
        try {
            const repUrl = new URL(REPUTATION_URL);
            repUrl.searchParams.set('owner', walletId);
            const repResp = await fetch(repUrl.toString());
            if (repResp.ok) {
                const repJson = await repResp.json();
                const recs    = Array.isArray(repJson.reputation_records)
                    ? repJson.reputation_records
                    : [];
                if (recs.length > 0) {
                    const rec = recs[0];
                    // проходим все поля rec, ищем массивы с item.token_id и item.reputation
                    for (const arr of Object.values(rec)) {
                        if (!Array.isArray(arr)) continue;
                        for (const item of arr) {
                            if (
                                item.token_id != null &&
                                typeof item.reputation === 'number'
                            ) {
                                repMap[String(item.token_id)] = item.reputation;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Bulk reputation fetch failed:', e);
        }

        // 4) Для тех token_id, которых нет в bulk-отдаче, делаем индивидуальный запрос
        const missing = tokenIds.filter(tid => !(tid in repMap));
        for (const tid of missing) {
            try {
                const url = new URL(REPUTATION_URL);
                url.searchParams.set('owner',    walletId);
                url.searchParams.set('token_id', tid);
                const r = await fetch(url.toString());
                if (!r.ok) continue;
                const j = await r.json();
                // если вернулся одиночный объект с полем reputation
                if (typeof j.reputation === 'number') {
                    repMap[tid] = j.reputation;
                }
                // иначе — если снова репутационные записи массивом
                else if (Array.isArray(j.reputation_records)) {
                    const recs = j.reputation_records;
                    if (recs.length > 0) {
                        const rec = recs[0];
                        for (const arr of Object.values(rec)) {
                            if (!Array.isArray(arr)) continue;
                            const match = arr.find(i => String(i.token_id) === tid);
                            if (match && typeof match.reputation === 'number') {
                                repMap[tid] = match.reputation;
                                break;
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn(`Error fetching reputation for token ${tid}:`, e);
            }
        }

        // 5) Группируем по отправителю и суммируем репутации
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from = tx.sender_id;
            const tid  = String(tx.args?.token_id ?? tx.token_id);
            const rep  = repMap[tid] || 0;
            acc[from]   = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 6) Формируем и отдаём отсортированный лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });
    } catch (err) {
        console.error('Unexpected error in handler:', err);
        return res.status(500).json({ error: err.message });
    }
}
