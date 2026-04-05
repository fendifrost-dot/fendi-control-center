import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GRAPH_API = "https://graph.facebook.com/v21.0";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const TOKEN = Deno.env.get("INSTAGRAM_MESSAGING_API_TOKEN");
  if (!TOKEN) {
    return new Response(
      JSON.stringify({ error: "INSTAGRAM_MESSAGING_API_TOKEN not configured" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  try {
    const { action, recipient_id, message, comment_id, reply_text, media_id } = await req.json();

    let result: any;

    switch (action) {
      case "send_dm": {
        // Send a DM via Instagram Messaging API
        // recipient_id = Instagram-scoped user ID (IGSID)
        if (!recipient_id || !message) {
          return new Response(
            JSON.stringify({ error: "recipient_id and message are required for send_dm" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // First get the Instagram Business Account ID
        const meResp = await fetch(`${GRAPH_API}/me?fields=instagram_business_account&access_token=${TOKEN}`);
        const meData = await meResp.json();
        const igAccountId = meData.instagram_business_account?.id;

        if (!igAccountId) {
          // Try direct page-level messaging
          const pageResp = await fetch(`${GRAPH_API}/me/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: recipient_id },
              message: { text: message },
              access_token: TOKEN,
            }),
          });
          result = await pageResp.json();
        } else {
          // Use IG messaging endpoint
          const dmResp = await fetch(`${GRAPH_API}/${igAccountId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              recipient: { id: recipient_id },
              message: { text: message },
              access_token: TOKEN,
            }),
          });
          result = await dmResp.json();
        }
        break;
      }

      case "reply_comment": {
        // Reply to an Instagram comment
        if (!comment_id || !reply_text) {
          return new Response(
            JSON.stringify({ error: "comment_id and reply_text are required for reply_comment" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const commentResp = await fetch(`${GRAPH_API}/${comment_id}/replies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: reply_text,
            access_token: TOKEN,
          }),
        });
        result = await commentResp.json();
        break;
      }

      case "reply_story_mention": {
        // Reply to a story mention via DM
        if (!recipient_id || !message) {
          return new Response(
            JSON.stringify({ error: "recipient_id and message are required for reply_story_mention" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        // Story mention replies go as DMs
        const storyResp = await fetch(`${GRAPH_API}/me/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: recipient_id },
            message: { text: message },
            access_token: TOKEN,
          }),
        });
        result = await storyResp.json();
        break;
      }

      case "get_recent_comments": {
        // Fetch recent comments on recent media for context
        const limit = 5;
        const mediaResp = await fetch(
          `${GRAPH_API}/me?fields=instagram_business_account{media.limit(${limit}){comments.limit(5){text,username,timestamp,id}}}&access_token=${TOKEN}`
        );
        result = await mediaResp.json();
        break;
      }

      case "lookup_user": {
        // Look up an Instagram user by username via Business Discovery API
        const username = (await req.json().catch(() => ({})))?.username || recipient_id;
        if (!username) {
          return new Response(
            JSON.stringify({ error: "username (or recipient_id) is required for lookup_user" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const cleanUsername = String(username).replace(/^@/, "").trim();
        const meResp2 = await fetch(`${GRAPH_API}/me?fields=instagram_business_account&access_token=${TOKEN}`);
        const meData2 = await meResp2.json();
        const igId2 = meData2.instagram_business_account?.id;
        if (!igId2) {
          result = { error: "No Instagram Business Account linked" };
          break;
        }
        const discResp = await fetch(
          `${GRAPH_API}/${igId2}?fields=business_discovery.fields(username,name,biography,followers_count,media_count,ig_id).username(${cleanUsername})&access_token=${TOKEN}`
        );
        const discData = await discResp.json();
        if (discData.error) {
          result = { found: false, error: discData.error.message, username: cleanUsername };
        } else {
          const bd = discData.business_discovery || {};
          result = { found: true, username: bd.username, name: bd.name, bio: bd.biography, followers: bd.followers_count, ig_id: bd.ig_id };
        }
        break;
      }

      case "get_conversations": {
        // List recent Instagram DM conversations
        const meResp = await fetch(`${GRAPH_API}/me?fields=instagram_business_account&access_token=${TOKEN}`);
        const meData = await meResp.json();
        const igId = meData.instagram_business_account?.id;
        if (!igId) {
          result = { error: "No Instagram Business Account linked" };
          break;
        }
        const convResp = await fetch(
          `${GRAPH_API}/${igId}/conversations?fields=participants,messages.limit(3){message,from,created_time}&platform=instagram&access_token=${TOKEN}`
        );
        result = await convResp.json();
        break;
      }

      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}. Valid: send_dm, reply_comment, reply_story_mention, get_recent_comments, lookup_user, get_conversations` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }

    // Check for Graph API errors
    if (result?.error) {
      console.error("Instagram Graph API error:", JSON.stringify(result.error));
      return new Response(
        JSON.stringify({ success: false, error: result.error.message || result.error }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, data: result }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Instagram messaging error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
