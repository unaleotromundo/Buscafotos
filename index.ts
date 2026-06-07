// ─────────────────────────────────────────────────────────────────────────────
// Edge Function: buscar-fotos
// Supabase → Edge Functions → New Function → nombre: "buscar-fotos"
// Pegá este código completo ahí.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Renovar token expirado usando el refresh_token ────────────────────────────
async function renovarToken(refreshToken: string): Promise<string | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken,
      grant_type:    "refresh_token",
    }),
  });

  if (!res.ok) return null;
  const json = await res.json();
  return json.access_token ?? null;
}

// ── Buscar fotos en UNA cuenta ────────────────────────────────────────────────
async function buscarEnCuenta(
  cuenta: { email: string; provider_token: string; provider_refresh_token: string | null },
  termino: string
): Promise<any[]> {

  let token = cuenta.provider_token;

  const hacerBusqueda = async (tkn: string) => {
    return fetch("https://photoslibrary.googleapis.com/v1/mediaItems:search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tkn}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pageSize: 50,
        filters: {
          textFilter: { textTerms: [termino] },
        },
      }),
    });
  };

  let res = await hacerBusqueda(token);

  // Si el token expiró (401), intentamos renovarlo
  if (res.status === 401 && cuenta.provider_refresh_token) {
    const nuevoToken = await renovarToken(cuenta.provider_refresh_token);
    if (!nuevoToken) return [];

    token = nuevoToken;
    res = await hacerBusqueda(token);
  }

  if (!res.ok) return [];

  const json = await res.json();
  const items = json.mediaItems ?? [];

  // Mapeamos y le agregamos el email de la cuenta para saber de dónde viene
  return items.map((item: any) => ({
    id:       item.id,
    url:      item.baseUrl,
    filename: item.filename,
    fecha:    item.mediaMetadata?.creationTime ?? null,
    cuenta:   cuenta.email,
  }));
}

// ── Handler principal ─────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {

  // Preflight CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { termino_busqueda } = await req.json();

    if (!termino_busqueda?.trim()) {
      return new Response(
        JSON.stringify({ error: "Falta el término de búsqueda" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Usamos service_role para leer TODAS las cuentas guardadas
    // (RLS no aplica con service_role, así podemos leer tokens de todos los usuarios)
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: cuentas, error: dbError } = await admin
      .from("cuentas_vinculadas")
      .select("email, provider_token, provider_refresh_token");

    if (dbError) throw dbError;
    if (!cuentas || cuentas.length === 0) {
      return new Response(
        JSON.stringify({ fotos: [], mensaje: "No hay cuentas vinculadas" }),
        { headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Buscamos en TODAS las cuentas en paralelo
    const resultados = await Promise.allSettled(
      cuentas.map(cuenta => buscarEnCuenta(cuenta, termino_busqueda.trim()))
    );

    // Juntamos todo, ignorando las que fallaron
    const fotos = resultados
      .filter(r => r.status === "fulfilled")
      .flatMap(r => (r as PromiseFulfilledResult<any[]>).value);

    return new Response(
      JSON.stringify({ fotos, total: fotos.length }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("Error en buscar-fotos:", err);
    return new Response(
      JSON.stringify({ error: err.message ?? "Error interno" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
