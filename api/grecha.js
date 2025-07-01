// api/nft-reputation.js
import fetch from 'node-fetch';

const TRANSFERS_URL         = 'https://dialog-tbot.com/history/nft-transfers/';
const UNIQUE_REPUTATION_URL = 'https://dialog-tbot.com/nft/unique-reputation/';
const DEFAULT_LIMIT         = 200;
const DEFAULT_SKIP          = 0;

export default async function handler(req, res) {
    const walletId = req.query.wallet_id;
    const limit    = Number(req.query.limit) || DEFAULT_LIMIT;
    const skip     = Number(req.query.skip)  || DEFAULT_SKIP;

    // Опциональный фильтр по дате (ISO-строки)
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
        // 1) Пагинация: скачиваем все входящие NFT-трансферы по кускам, пока не кончатся или не выйдем за период
        const allTransfers = [];
        let offset = skip;
        while (true) {
            const url = new URL(TRANSFERS_URL);
            url.searchParams.set('wallet_id', walletId);
            url.searchParams.set('direction',  'in');
            url.searchParams.set('limit',      String(limit));
            url.searchParams.set('skip',       String(offset));

            const resp = await fetch(url.toString());
            if (!resp.ok) break;
            const { nft_transfers: batch } = await resp.json();
            if (!Array.isArray(batch) || batch.length === 0) break;

            // фильтрация по временному промежутку
            const filtered = batch.filter(tx => {
                if (startNano === null && endNano === null) return true;
                if (!tx.timestamp_nanosec) return false;
                const ts = BigInt(tx.timestamp_nanosec);
                if (startNano !== null && ts < startNano) return false;
                if (endNano   !== null && ts > endNano)   return false;
                return true;
            });
            allTransfers.push(...filtered);

            // если фильтруем по startNano и самый старый в batch уже до фильтра, можно выйти
            if (startNano !== null) {
                const last = batch[batch.length - 1];
                if (last.timestamp_nanosec) {
                    const lastTs = BigInt(last.timestamp_nanosec);
                    if (lastTs < startNano) break;
                }
            }

            offset += limit;
        }

        // 2) Получаем репутации по названиям из UNIQUE_REPUTATION_URL
        const repResp = await fetch(UNIQUE_REPUTATION_URL);
        const repMap  = {};
        if (repResp.ok) {
            const repJson = await repResp.json();
            const records = Array.isArray(repJson.nfts) ? repJson.nfts : [];
            for (const item of records) {
                if (typeof item.title === 'string' && typeof item.reputation === 'number') {
                    repMap[item.title.trim().toLowerCase()] = item.reputation;
                }
            }
        } else {
            console.warn(`Unique-reputation API returned ${repResp.status}, skipping reputations`);
        }

        // 3) Группируем по sender_id и суммируем по совпадению title
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from  = tx.sender_id;
            const title = String(tx.args?.title || '')
                .trim()
                .toLowerCase();
            const rep   = repMap[title] || 0;
            acc[from]   = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 4) Формируем и возвращаем отсортированный лидерборд
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });
    } catch (err) {
        console.error('Error in nft-reputation handler:', err);
        return res.status(500).json({ error: err.message });
    }
}
