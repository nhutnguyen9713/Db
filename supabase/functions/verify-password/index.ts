// TN5 Dashboard — Edge Function "verify-password"
//
// Kiểm tra mật khẩu (mở khoá màn hình chặn ca ở lock.html / mở khoá tab ẩn+khoá trang trong app.js)
// HOÀN TOÀN Ở SERVER — mật khẩu thật chỉ nằm trong Secrets của Edge Function này (Project Settings
// -> Edge Functions -> Secrets trên Supabase Dashboard), KHÔNG còn nằm trong bất kỳ file mã nguồn
// nào (app.js/lock.html) hay trong bảng dashboard_kv nữa — ai tải nguyên trang này về mở lên/xem mã
// nguồn cũng không tìm được mật khẩu thật ở đâu cả. Client chỉ gửi mật khẩu người dùng vừa gõ lên
// đây, nhận lại đúng/sai — không có cách nào đọc ngược lại được mật khẩu thật từ phía client.
//
// "which": "gate" | "applock" | "setup".
//   - "gate"/"applock": trả về { ok } — dùng cho 2 màn khoá hiện có.
//   - "setup": trả về { ok, url, anonKey } khi đúng mật khẩu CẤU HÌNH NHANH (SETUP_PASSWORD) — để
//     máy MỚI chỉ cần gõ 1 mật khẩu ngắn thay vì tự dán Project URL + anon public key (dài, khó nhớ).
//     url/anonKey lấy thẳng từ 2 biến môi trường Supabase TỰ ĐỘNG cấp cho mọi Edge Function
//     (SUPABASE_URL/SUPABASE_ANON_KEY — không cần khai thêm Secret nào cho 2 giá trị này).
//
// Cần cấu hình 3 Secrets trước khi dùng (Project Settings -> Edge Functions -> Secrets, KHÔNG phải
// biến môi trường thường — Secrets không hiện lại được sau khi lưu, chỉ ghi đè):
//   GATE_PASSWORD      — mật khẩu mở khoá màn hình chặn ca (lock.html)
//   APP_LOCK_PASSWORD  — mật khẩu hiện lại tab ẩn / mở khoá sau khi "Khoá trang ngay" (Cài đặt trong app.js)
//   SETUP_PASSWORD     — mật khẩu cấu hình nhanh Cloud cho máy mới (nút "⚡ Cấu hình nhanh" trong Cài đặt)

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  try {
    const body = await req.json();
    const which = body && body.which;
    const password = body && body.password;

    if (which === "setup") {
      const expected = Deno.env.get("SETUP_PASSWORD");
      const ok = typeof expected === "string" && expected.length > 0 &&
        typeof password === "string" && password === expected;
      if (!ok) {
        return new Response(JSON.stringify({ ok: false }), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        url: Deno.env.get("SUPABASE_URL"),
        anonKey: Deno.env.get("SUPABASE_ANON_KEY"),
      }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const expected = which === "applock"
      ? Deno.env.get("APP_LOCK_PASSWORD")
      : which === "gate"
      ? Deno.env.get("GATE_PASSWORD")
      : null;
    const ok = typeof expected === "string" && expected.length > 0 &&
      typeof password === "string" && password === expected;
    return new Response(JSON.stringify({ ok }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (_e) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
