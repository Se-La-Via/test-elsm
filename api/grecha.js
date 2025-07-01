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

    // 1) Парсим и валидируем опциональные интервалы
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
        return res
            .status(400)
            .json({ error: 'Parameter wallet_id is required' });
    }

    try {
        // 2) Собираем все входящие NFT-трансферы
        let allTransfers = [];
        for (let offset = skip; ; offset += limit) {
            const url = new URL(TRANSFERS_URL);
            url.searchParams.set('wallet_id', walletId);
            url.searchParams.set('direction', 'in');
            url.searchParams.set('limit', String(limit));
            url.searchParams.set('skip',  String(offset));

            const r = await fetch(url.toString());
            if (!r.ok) break;
            const { nft_transfers: batch } = await r.json();
            if (!Array.isArray(batch) || batch.length === 0) break;

            // 3) Фильтруем по timestamp_nanosec (только если заданы startNano/endNano)
            const filtered = batch.filter(tx => {
                // если ни даты начала, ни даты конца не заданы — не фильтруем
                if (startNano === null && endNano === null) {
                    return true;
                }
                // пропускаем, если нет поля timestamp_nanosec
                if (tx.timestamp_nanosec == null) {
                    return false;
                }
                const ts = BigInt(tx.timestamp_nanosec);
                if (startNano !== null && ts < startNano) return false;
                if (endNano   !== null && ts > endNano)   return false;
                return true;
            });

            allTransfers = allTransfers.concat(filtered);
            if (batch.length < limit) break;
        }

        // 4) Собираем множество токенов, реально пришедших в фильтре
        const transferredTokenIds = new Set(
            allTransfers.map(tx =>
                (tx.args && tx.args.token_id) || tx.token_id
            )
        );

        // 5) Получаем репутацию владельца
        const repUrl  = new URL(REPUTATION_URL);
        repUrl.searchParams.set('owner', walletId);
        const repResp = await fetch(repUrl.toString());
        if (!repResp.ok) {
            throw new Error(`Reputation API error: ${repResp.status}`);
        }
        const repJson = await repResp.json();

        // 6) Формируем map token_id → reputation (учитываем только отфильтрованные токены)
        const repMap = {};
        const records = Array.isArray(repJson.reputation_records)
            ? repJson.reputation_records
            : [];
        if (records.length > 0) {
            const rec = records[0];
            ['horse_items', 'volga_items', 'reputation_nfts'].forEach(cat => {
                (Array.isArray(rec[cat]) ? rec[cat] : []).forEach(item => {
                    if (transferredTokenIds.has(item.token_id)) {
                        repMap[item.token_id] = item.reputation;
                    }
                });
            });
        }

        // 7) Группируем по отправителю и суммируем репутации
        const sumsBySender = allTransfers.reduce((acc, tx) => {
            const from = tx.sender_id;
            const tid  = (tx.args && tx.args.token_id) || tx.token_id;
            const rep  = repMap[tid] || 0;
            acc[from]  = (acc[from] || 0) + rep;
            return acc;
        }, {});

        // 8) Сортируем итоговый лидерборд и возвращаем
        const leaderboard = Object.entries(sumsBySender)
            .map(([wallet, total]) => ({ wallet, total }))
            .sort((a, b) => b.total - a.total);

        return res.status(200).json({ leaderboard });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: err.message });
    }
}
