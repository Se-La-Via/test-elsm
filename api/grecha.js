// api/grecha.js
import fetch from 'node-fetch';

const API_URL = 'https://dialog-tbot.com/history/ft-transfers/?wallet_id=oao_north.near&direction=in&symbol=GRECHA&limit=50&skip=0';

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

// Параметр limit=50 в этом запросе задаёт максимальное число записей, которые API вернёт в одном ответе.
// limit (ограничитель) — сколько переводов вернуть (здесь до 50).
// skip=0 (смещение) — с какого по счёту элемента начинать (здесь — с самого первого).
// Вместе они реализуют простую пагинацию:
//     Первый запрос: limit=50&skip=0 вернёт переводы с 1-го по 50-й.
//     Чтобы получить следующую «страницу», вы делаете limit=50&skip=50 — и тогда API отдаст 51–100.
// И так далее.
//     Если нужно сразу больше записей, увеличьте limit, но учитывайте, что некоторые API накладывают жёсткое ограничение (например, не больше 100 или 500 за один вызов).
