export default async function handler(request) {
  try {
    const url = new URL(request.url);
    const mint = url.searchParams.get("mint")?.trim();

    if (!mint) {
      return Response.json(
        { error: "Missing token address" },
        { status: 400 }
      );
    }

    const apiKey = process.env.HELIUS_API_KEY;

    if (!apiKey) {
      return Response.json(
        { error: "HELIUS_API_KEY is not configured" },
        { status: 500 }
      );
    }

    const heliusResponse = await fetch(
      `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "nova",
          method: "getAsset",
          params: {
            id: mint,
            displayOptions: {
              showFungible: true
            }
          }
        })
      }
    );

    const data = await heliusResponse.json();

    if (!heliusResponse.ok || data.error) {
      return Response.json(
        {
          error: data.error?.message || "Helius request failed"
        },
        { status: 502 }
      );
    }

    const asset = data.result;

    const result = {
      mint: mint,

      name: asset?.content?.metadata?.name || null,

      symbol: asset?.content?.metadata?.symbol || null,

      decimals: asset?.token_info?.decimals ?? null,

      supply: asset?.token_info?.supply ?? null,

      price:
        asset?.token_info?.price_info?.price_per_token ?? null,

      image:
        asset?.content?.links?.image ||
        asset?.content?.files?.[0]?.uri ||
        null,

      website:
        asset?.content?.links?.external_url ||
        asset?.content?.links?.website ||
        null,

      links: asset?.content?.links || null
    };

    return Response.json(result);
  } catch (error) {
    console.error(error);

    return Response.json(
      {
        error: "Server error while scanning token"
      },
      { status: 500 }
    );
  }
}
