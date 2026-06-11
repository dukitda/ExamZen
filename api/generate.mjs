// ExamZen - Vercel 서버리스 함수 (v7: 모델 목록 갱신 — 1.5-flash 은퇴, 2.5-flash-lite 1순위)
// 강의 텍스트(또는 PDF)를 받아 Gemini API로 보내고, 개념 정리 + 시험 문제를 JSON으로 돌려준다.
// API 키는 코드에 없다. Vercel 환경변수(GEMINI_API_KEY)에서 읽는다.

export const config = { maxDuration: 60 };

const MODELS = ["gemini-2.5-flash-lite", "gemini-2.0-flash-lite", "gemini-2.0-flash", "gemini-2.5-flash", "gemini-flash-latest"];

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

  const t0 = Date.now();
  const BUDGET = 45000; // 45초 넘기면 멈추고 깔끔한 에러 반환(플랫폼 타임아웃 회피)

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const text = (body.text || "").toString().trim();
    const pdfs = Array.isArray(body.pdfs) ? body.pdfs.filter((p) => p && p.data) : [];
    const types = Array.isArray(body.types) && body.types.length ? body.types : ["mc4"];
    const count = Math.max(3, Math.min(40, parseInt(body.count) || 10));
    const difficulty = Math.max(0, Math.min(100, parseInt(body.difficulty) || 30));

    const hasText = text.length >= 20;
    if (!hasText && pdfs.length === 0) {
      return res.status(400).json({ error: "강의 내용을 붙여넣거나 PDF를 올려주세요." });
    }

    const typeList = types.map((t) => "- " + t + ": " + (TYPE_GUIDE[t] || "")).join("\n");
    const diffWord = difficulty < 34 ? "비교적 쉬운 편(기초 개념 확인 위주)"
                   : difficulty < 67 ? "중간 난이도(적용·비교 포함)"
                   : "어려운 편(분석·종합·함정 포함, '바람직한 어려움' 원리 적용)";

    const lines = [
      "당신은 인지심리학 기반 학습 원리(시험 효과, 바람직한 어려움)를 아는 한국어 시험 출제 전문가입니다.",
      "아래 강의 자료만을 근거로 학생의 장기 기억을 강화하는 시험을 만드세요. 자료에 없는 사실을 지어내지 마세요.",
      ""
    ];
    if (hasText) { lines.push("[강의 내용(텍스트)]", text.slice(0, 12000), ""); }
    if (pdfs.length) { lines.push("[강의 내용] 첨부된 PDF 파일(들)이 강의 자료입니다. 그 내용을 근거로 출제하세요.", ""); }
    const ex = body.examInfo || {};
    const exParts = [];
    if (ex.subject) exParts.push("과목·시험명: " + String(ex.subject).slice(0, 60));
    if (ex.org) exParts.push("학교·기관: " + String(ex.org).slice(0, 60));
    if (ex.kind) exParts.push("시험 종류: " + String(ex.kind).slice(0, 30));
    if (exParts.length) {
      lines.push(
        "[시험 정보] " + exParts.join(" / "),
        "- 위 시험에서 전형적으로 쓰이는 출제 스타일·문체·자주 나오는 문제 형식을 반영해 출제한다.",
        "- 단, 문제의 내용 자체는 반드시 위 강의 자료에 근거한다. 자료에 없는 사실을 시험 경향이라는 이유로 지어내지 않는다.",
        ""
      );
    }
    lines.push(
      "[요구사항]",
      "- 자료가 영어 등 외국어여도 모든 출력(개념·정의·문제·보기·해설)은 한국어로 작성하고, 핵심 전문용어는 영어를 병기한다. 예: 작업기억(working memory).",
      "- 핵심 개념 3~5개를 골라 정리한다.",
      "- 문제는 총 " + count + "개. 선택된 유형들에 고르게 배분한다.",
      "- 난이도: " + diffWord + ".",
      "- 선택된 문제 유형:",
      typeList,
      "",
      '[출력 형식] 반드시 아래 JSON 구조로만, 다른 말 없이 출력:',
      '{ "concepts": [ { "term": "개념", "definition": "정의(2~3문장)", "example": "예시 1문장" } ],',
      '  "questions": [ { "type": "유형코드", "question": "지문", "options": ["보기 또는 빈 배열"], "answer": "정답", "explanation": "한 줄 해설", "concept": "이 문제가 묻는 개념(반드시 위 concepts의 term 중 하나)" } ] }'
    );
    const prompt = lines.join("\n");

    const parts = [{ text: prompt }];
    for (const p of pdfs.slice(0, 3)) {
      parts.push({ inlineData: { mimeType: p.mimeType || "application/pdf", data: p.data } });
    }

    const payload = {
      contents: [{ parts: parts }],
      generationConfig: { temperature: 0.7, responseMimeType: "application/json" }
    };

    const errors = [];
    let raw = null;
    let timedOut = false;

    for (const model of MODELS) {
      if (Date.now() - t0 > BUDGET) { timedOut = true; break; }
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;
      let done = false;
      for (let attempt = 0; attempt < 2 && !done; attempt++) {
        if (Date.now() - t0 > BUDGET) { timedOut = true; done = true; break; }
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
          if (attempt < 1 && Date.now() - t0 < BUDGET - 3000) { await sleep(1200); continue; }
          done = true;
          break;
        }

        const tx = await r.text();
        errors.push(model + ":" + status + " " + tx.slice(0, 100));
        done = true;
        break;
      }
      if (raw) break;
      if (timedOut) break;
    }

    if (!raw) {
      if (timedOut) return res.status(503).json({ error: "AI가 지금 혼잡합니다(시간 초과). 잠시 후 다시 시도하거나, 문제 수를 줄여 보세요." });
      return res.status(502).json({ error: "AI 호출 실패 — " + errors.join(" | ") });
    }

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
