import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const PAGE_ACCESS_TOKEN = Deno.env.get("Artist_Growth_Hub_Meta");
    if (!PAGE_ACCESS_TOKEN) {
      console.error("❌ Artist_Growth_Hub_Meta secret is not set");
      return new Response(
        JSON.stringify({ valid: false, scopes: [], error: "Artist_Growth_Hub_Meta secret not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("🔍 Validating Meta Page Access Token...");
    console.log(`📏 Token length: ${PAGE_ACCESS_TOKEN.length}`);

    // Call Graph API debug_token endpoint
    // debug_token requires an app token or the same token as both input and access token
    const url = `https://graph.facebook.com/v21.0/debug_token?input_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;

    const response = await fetch(url);
    const data = await response.json();

    console.log("📨 Graph API response:", JSON.stringify(data, null, 2));

    if (data.error) {
      console.error("❌ Graph API error:", data.error.message);
      return new Response(
        JSON.stringify({ valid: false, scopes: [], error: data.error.message }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tokenData = data.data;
    if (!tokenData) {
      return new Response(
        JSON.stringify({ valid: false, scopes: [], error: "No token data returned" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const isValid = tokenData.is_valid === true;
    const scopes: string[] = tokenData.scopes || [];
    const type = tokenData.type || "unknown";
    const appId = tokenData.app_id || "unknown";
    const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at * 1000).toISOString() : "never";

    // Check required scopes (only current/valid Meta permissions — no deprecated ones)
    // Deprecated and must NOT be requested: manage_pages, pages_show_list
    const requiredScopes = [
      "pages_messaging",           // Send/receive Messenger messages
      "pages_read_engagement",     // Read page posts & comments
      "pages_manage_metadata",     // Subscribe to webhooks
      "instagram_basic",           // Basic IG account info
      "instagram_manage_messages", // IG Direct messages
      "instagram_manage_comments", // Reply to IG comments
    ];
    const missingScopes = requiredScopes.filter((s) => !scopes.includes(s));

    const result = {
      valid: isValid,
      type,
      app_id: appId,
      expires_at: expiresAt,
      scopes,
      required_scopes: requiredScopes,
      missing_scopes: missingScopes,
      all_required_present: missingScopes.length === 0,
      error: isValid ? "" : "Token is not valid",
    };

    console.log("✅ Validation result:", JSON.stringify(result, null, 2));

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("💥 Unexpected error:", err);
    return new Response(
      JSON.stringify({ valid: false, scopes: [], error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
