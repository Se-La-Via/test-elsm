// api/grecha.js
import fetch from 'node-fetch';

const API_URL = 'https://dialog-tbot.com/history/ft-transfers/?wallet_id=oao_north.near&direction=in&symbol=GRECHA&limit=200&skip=0';

export default async function handler(req, res) {
    try {
        const upstream = await fetch(API_URL);
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
