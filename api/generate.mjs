// ExamZen - Vercel 서버리스 함수 (v3: 자동 재시도 + 모델 확장 + 진단)
// 강의 텍스트 + 설정을 받아 Gemini API로 보내고, 개념 정리 + 시험 문제를 JSON으로 돌려준다.
// API 키는 코드에 없다. Vercel 환경변수(GEMINI_API_KEY)에서 읽는다.

export const config = { maxDuration: 60 };

// 여유 많은 lite를 앞에, 그다음 일반 flash들. 되는 게 나올 때까지 시도.
const MODELS = ["gemini-2.0-flash-lite", "gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash", "gemini-flash-latest"];

const TYPE_GUIDE = {
  mc4:   "객관식 4지선다. options 배열에 보기 4개를 '① ...','② ...','③ ...','④ ...' 형식으로.",
  mc5:   "객관식 5지선다. options 배열에 보기 5개를 '① ...' ~ '⑤ ...' 형식으로.",
  ox:    "OX 퀴즈. options 배열은 정확히 ['O — 맞다','X — 틀리다'].",
  blank: "괄호 넣기. question 안에 ( ① ),( ② ) 같은 빈칸을 넣는다. options는 빈 배열 [].",
  sa:    "단답형. options는 빈 배열 []. answer는 핵심 정답.",
  essay: "서술형. options는 빈 배열 []. answer는 모범답안 요지."
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST만 허용됩니다." });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "서버에 GEMINI_API_KEY가 설정되지 않았습니다." });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const text = (body.text || "").toString().trim();
    const types = Array.isArray(body.types) && body.types.length ? body.types : ["mc4"];
    const count = Math.max(3, Math.min(40, parseInt(body.count) || 10));
    const difficulty = Math.max(0, Math.min(100, parseInt(body.difficulty) || 30));

    if (text.length < 20) return res.status(400).json({ error: "강의 내용을 더 붙여넣어 주세요. (최소 20자)" });

    const typeList = types.map((t) => "- " + t + ": " + (TYPE_GUIDE[t] || "")).join("\n");
    const diffWord = difficulty < 34 ? "비교적 쉬운 편(기초 개념 확인 위주)"
                   : difficulty < 67 ? "중간 난이도(적용·비교 포함)"
                   : "어려운 편(분석·종합·함정 포함, '바람직한 어려움' 원리 적용)";

    const prompt = [
      "당신은 인지심리학 기반 학습 원리(시험 효과, 바람직한 어려움)를 아는 한국어 시험 출제 전문가입니다.",
      "아래 [강의 내용]만을 근거로 학생의 장기 기억을 강화하는 시험을 만드세요. 강의에 없는 사실을 지어내지 마세요.",
      "",
      "[강의 내용]",
      text.slice(0, 12000),
      "",
      "[요구사항]",
      "- 핵심 개념 3~5개를 골라 정리한다.",
      "- 문제는 총 " + count + "개. 선택된 유형들에 고르게 배분한다.",
      "- 난이도: " + diffWord + ".",
      "- 선택된 문제 유형:",
      typeList,
      "",
      '[출력 형식] 반드시 아래 JSON 구조로만, 다른 말 없이 출력:',
      '{ "concepts": [ { "term": "개념", "definition": "정의(2~3문장)", "example": "예시 1문장" } ],',
      '  "questions": [ { "type": "유형코드", "question": "지문", "options": ["보기 또는 빈 배열"], "answer": "정답", "explanation": "한 줄 해설" } ] }'
    ].join("\n");

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, responseMimeType: "application/json" }
    };

    const errors = [];
    let raw = null;

    for (const model of MODELS) {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;
      let done = false;
      for (let attempt = 0; attempt < 3 && !done; attempt++) {
        let r;
        try {
          r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });
        } catch (e) {
          errors.push(model + ":네트워크");
          done = true;
          break;
        }

        if (r.ok) {
          const data = await r.json();
          const cand = data && data.candidates && data.candidates[0];
          const part = cand && cand.content && cand.content.parts && cand.content.parts[0];
          raw = part && part.text;
          if (raw) { done = true; break; }
          errors.push(model + ":빈응답");
          done = true;
          break;
        }

        const status = r.status;
        if (status === 503 || status === 429) {
          errors.push(model + ":" + status + "(시도" + (attempt + 1) + ")");
          if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
          done = true;
          break;
        }

        const t = await r.text();
        errors.push(model + ":" + status + " " + t.slice(0, 100));
        done = true;
        break;
      }
      if (raw) break;
    }

    if (!raw) return res.status(502).json({ error: "AI 호출 실패 — " + errors.join(" | ") });

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(502).json({ error: "AI 응답 해석 실패: " + raw.slice(0, 200) });
      parsed = JSON.parse(m[0]);
    }

    return res.status(200).json({
      concepts: Array.isArray(parsed.concepts) ? parsed.concepts : [],
      questions: Array.isArray(parsed.questions) ? parsed.questions : []
    });
  } catch (err) {
    return res.status(500).json({ error: "서버 오류 — " + String(err).slice(0, 300) });
  }
}
