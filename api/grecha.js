// api/grecha.js
import fetch from 'node-fetch';

const BASE_URL = 'https://dialog-tbot.com/history/ft-transfers/';
const DEFAULT_WALLET = 'oao_north.near';
const DEFAULT_SYMBOL = 'GRECHA';
const DEFAULT_LIMIT = 100;
const DEFAULT_SKIP  = 0;

export default async function handler(req, res) {
    // Read parameters from query (if not set, use defaults)
    const wallet = Number(req.query.wallet) || DEFAULT_WALLET;
    const symbol  = Number(req.query.symbol)  || DEFAULT_SYMBOL;
    const limit = Number(req.query.limit) || DEFAULT_LIMIT;
    const skip  = Number(req.query.skip)  || DEFAULT_SKIP;

    // 2) Формируем URL к upstream с параметрами
    const upstreamUrl = new URL(BASE_URL);
    upstreamUrl.searchParams.set('wallet_id', wallet);
    upstreamUrl.searchParams.set('direction', 'in');
    upstreamUrl.searchParams.set('symbol', symbol);
    upstreamUrl.searchParams.set('limit',  limit);
    upstreamUrl.searchParams.set('skip',   skip);

    try {
        const upstream = await fetch(upstreamUrl.toString());
        if (!upstream.ok) {
            const text = await upstream.text().catch(() => '');
            return res
                .status(upstream.status)
                .json({ error: `Upstream ${upstream.status}: ${text}` });
        }
        const json = await upstream.json();
        return res.status(200).json(json);

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}
