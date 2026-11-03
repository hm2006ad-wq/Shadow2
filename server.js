import "dotenv/config";
import express from "express";
import cron from "node-cron";
import OpenAI from "openai";
import { v2 as cloudinary } from "cloudinary";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

const required = [
  "OPENAI_API_KEY", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET", "IG_USER_ID", "IG_ACCESS_TOKEN",
  "GRAPH_API_VERSION", "ADMIN_SECRET"
];
const missing = required.filter(k => !process.env[k] || process.env[k].includes("your_") || process.env[k] === "vXX.X");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

let lastRun = { status: "not_started", message: "لم يبدأ النشر بعد", at: null };
let isPublishing = false;

function safeCaption(text) {
  // Instagram captions have a maximum length; keep a little margin.
  return String(text || "").slice(0, 2100);
}

async function createPostPlan() {
  const response = await openai.responses.create({
    model: process.env.OPENAI_TEXT_MODEL || "gpt-6-astra",
    input: [
      {
        role: "system",
        content: `أنت محرر محتوى لحساب Instagram. اختر بنفسك فكرة جديدة مفيدة وآمنة ضمن المجال التالي: ${process.env.POST_THEME || "معلومات عامة مفيدة"}. لا تكرر أفكاراً واضحة، ولا تخترع إحصاءات أو حقائق أو أخباراً. تجنب الادعاءات الطبية والمالية والقانونية، والسياسة، والمحتوى الحساس. اكتب بلغة ${process.env.POST_LANGUAGE || "العربية"}. أخرج JSON فقط بالشكل:
{"topic":"عنوان الفكرة","image_prompt":"وصف بصري واضح لصورة مربعة جذابة بلا كتابة أو شعارات أو علامات مائية","caption":"وصف عربي قصير مع دعوة لطيفة للتفاعل و3 إلى 6 هاشتاغات مناسبة"}.`
      },
      { role: "user", content: "أنشئ فكرة منشور اليوم." }
    ]
  });

  const raw = response.output_text?.trim() || "";
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const plan = JSON.parse(cleaned);
  if (!plan.topic || !plan.image_prompt || !plan.caption) {
    throw new Error("لم يُرجع النموذج بيانات المنشور كاملة.");
  }
  return plan;
}

async function generateAndHostImage(prompt) {
  const result = await openai.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
    prompt: `${prompt}. Square 1:1 Instagram post image, polished editorial design, no text, no logos, no watermark.`,
    size: "1024x1024",
    quality: "medium"
  });

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("لم تصل الصورة من خدمة توليد الصور.");
  const buffer = Buffer.from(b64, "base64");

  const uploaded = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "insta-creator-ai", resource_type: "image", format: "jpg" },
      (error, result) => error ? reject(error) : resolve(result)
    );
    stream.end(buffer);
  });
  return uploaded.secure_url;
}

async function publishToInstagram(imageUrl, caption) {
  const base = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}`;
  const create = await fetch(`${base}/${process.env.IG_USER_ID}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      image_url: imageUrl,
      caption: safeCaption(caption),
      access_token: process.env.IG_ACCESS_TOKEN
    })
  });
  const createData = await create.json();
  if (!create.ok || !createData.id) {
    throw new Error(`فشل إنشاء منشور Instagram: ${JSON.stringify(createData)}`);
  }

  const publish = await fetch(`${base}/${process.env.IG_USER_ID}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      creation_id: createData.id,
      access_token: process.env.IG_ACCESS_TOKEN
    })
  });
  const publishData = await publish.json();
  if (!publish.ok || !publishData.id) {
    throw new Error(`فشل نشر المنشور: ${JSON.stringify(publishData)}`);
  }
  return publishData.id;
}

async function runDailyPost() {
  if (missing.length) throw new Error(`أكمل إعدادات الخادم أولاً: ${missing.join(", ")}`);
  if (isPublishing) return { skipped: true, message: "هناك عملية نشر قيد التنفيذ." };

  isPublishing = true;
  try {
    lastRun = { status: "working", message: "جاري إنشاء المنشور...", at: new Date().toISOString() };
    const plan = await createPostPlan();
    const imageUrl = await generateAndHostImage(plan.image_prompt);
    const mediaId = await publishToInstagram(imageUrl, plan.caption);
    lastRun = {
      status: "success",
      message: `تم نشر: ${plan.topic}`,
      topic: plan.topic,
      caption: plan.caption,
      mediaId,
      imageUrl,
      at: new Date().toISOString()
    };
    return lastRun;
  } catch (error) {
    lastRun = { status: "error", message: error.message, at: new Date().toISOString() };
    throw error;
  } finally {
    isPublishing = false;
  }
}

app.get("/api/status", (_req, res) => {
  res.json({
    configured: missing.length === 0,
    missing,
    lastRun,
    schedule: process.env.POST_CRON || "0 19 * * *",
    timezone: process.env.TIME_ZONE || "Africa/Algiers"
  });
});

app.post("/api/run-now", async (req, res) => {
  if (req.headers["x-admin-secret"] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "غير مصرح." });
  }
  try {
    res.json(await runDailyPost());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const cronExpression = process.env.POST_CRON || "0 19 * * *";
const timezone = process.env.TIME_ZONE || "Africa/Algiers";
if (!cron.validate(cronExpression)) {
  throw new Error("POST_CRON غير صالح.");
}
cron.schedule(cronExpression, async () => {
  try {
    await runDailyPost();
  } catch (error) {
    console.error("Daily post failed:", error.message);
  }
}, { timezone });

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Insta Creator AI يعمل على المنفذ ${port}`);
  if (missing.length) console.log("إعدادات ناقصة:", missing.join(", "));
});
