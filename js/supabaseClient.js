// window.supabase는 supabase-js UMD 번들(CDN)이 등록하는 전역 객체입니다.
const supabaseClient = window.supabase.createClient(
  window.SUPABASE_CONFIG.url,
  window.SUPABASE_CONFIG.anonKey,
);
