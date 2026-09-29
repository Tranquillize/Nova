module.exports = async function handler(req, res) {
  try {
    const mint = String(req.query.mint || "").trim();
    if (!mint) return res.status(400).json({ error: "Missing token address" });

    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "HELIUS_API_KEY is not configured" });
    }

    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;

    async function rpc(method, params) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "nova", method, params })
      });
      const json = await response.json();
      if (!response.ok || json.error) {
        throw new Error(json.error?.message || `${method} failed`);
      }
      return json.result;
    }

    async function safe(name, fn) {
      try {
        return await fn();
      } catch (error) {
        console.error(name + " failed:", error.message);
        return null;
      }
    }

    // 1. Basisgegevens
    let asset;
    try {
      asset = await rpc("getAsset", {
        id: mint,
        displayOptions: { showFungible: true }
      });
    } catch (error) {
      return res.status(502).json({ error: error.message });
    }

    const supply = asset?.token_info?.supply ?? null;
    const decimals = asset?.token_info?.decimals ?? null;

    // 2. Alles hieronder loopt tegelijk en mag los falen
    const [mintInfo, topHolders, holderInfo, activity] = await Promise.all([
      // Authorities (mint/freeze)
      safe("mintInfo", async () => {
        const info = await rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
        const parsed = info?.value?.data?.parsed?.info;
        if (!parsed) return null;
        return {
          mintAuthorityActive: !!parsed.mintAuthority,
          freezeAuthorityActive: !!parsed.freezeAuthority
        };
      }),

      // Top 10 holders (met eigenaar-wallet)
      safe("topHolders", async () => {
        const largest = await rpc("getTokenLargestAccounts", [mint]);
        const accounts = (largest?.value || []).slice(0, 10);
        if (!accounts.length || !supply) return null;

        const owners = await safe("owners", async () => {
          const multi = await rpc("getMultipleAccounts", [
            accounts.map((a) => a.address),
            { encoding: "jsonParsed" }
          ]);
          return (multi?.value || []).map(
            (v) => v?.data?.parsed?.info?.owner || null
          );
        });

        return accounts.map((a, i) => ({
          tokenAccount: a.address,
          owner: owners ? owners[i] : null,
          amount: Number(a.amount),
          percent: (Number(a.amount) / Number(supply)) * 100
        }));
      }),

      // Aantal holders (maximaal 3 pagina's van 1000)
      safe("holders", async () => {
        const pages = await Promise.all(
          [1, 2, 3].map((page) =>
            rpc("getTokenAccounts", { mint, page, limit: 1000 })
          )
        );
        const owners = new Set();
        let lastPageFull = false;
        pages.forEach((p, idx) => {
          const list = p?.token_accounts || [];
          list.forEach((t) => {
            if (Number(t.amount) > 0) owners.add(t.owner);
          });
          if (idx === 2 && list.length === 1000) lastPageFull = true;
        });
        return { count: owners.size, capped: lastPageFull };
      }),

      // Recente transacties + 24u telling
      safe("activity", async () => {
        const sigs = await rpc("getSignaturesForAddress", [mint, { limit: 1000 }]);
        const list = Array.isArray(sigs) ? sigs : [];
        const dayAgo = Math.floor(Date.now() / 1000) - 86400;
        const last24h = list.filter((s) => s.blockTime && s.blockTime >= dayAgo);
        return {
          count24h: last24h.length,
          capped: list.length === 1000 && last24h.length === 1000,
          recent: list.slice(0, 10).map((s) => ({
            signature: s.signature,
            time: s.blockTime || null,
            failed: !!s.err
          }))
        };
      })
    ]);

    // 3. Top 10 percentage
    let top10Percent = null;
    if (topHolders && supply) {
      const total = topHolders.reduce((sum, h) => sum + h.amount, 0);
      top10Percent = (total / Number(supply)) * 100;
    }

    // 4. Rugpull risk (alleen on-chain signalen, geen garantie)
    const signals = [];
    let score = 0;
    function add(label, points, detail) {
      if (points > 0) score += points;
      signals.push({ label, points, detail });
    }

    if (mintInfo) {
      add(
        "Mint authority",
        mintInfo.mintAuthorityActive ? 25 : 0,
        mintInfo.mintAuthorityActive
          ? "Er kunnen nog nieuwe tokens bijgemaakt worden."
          : "Mint authority is uitgeschakeld."
      );
      add(
        "Freeze authority",
        mintInfo.freezeAuthorityActive ? 15 : 0,
        mintInfo.freezeAuthorityActive
          ? "Wallets kunnen bevroren worden."
          : "Freeze authority is uitgeschakeld."
      );
    }

    if (top10Percent !== null) {
      const pts = top10Percent > 60 ? 30 : top10Percent > 40 ? 20 : top10Percent > 25 ? 10 : 0;
      add("Top 10 concentratie", pts, `De top 10 accounts bezitten ${top10Percent.toFixed(1)}% van de supply.`);
    }

    if (topHolders && topHolders[0]) {
      const p = topHolders[0].percent;
      const pts = p > 30 ? 20 : p > 15 ? 10 : 0;
      add("Grootste holder", pts, `De grootste account bezit ${p.toFixed(1)}% van de supply.`);
    }

    if (holderInfo) {
      const c = holderInfo.count;
      const pts = c < 50 ? 20 : c < 200 ? 10 : 0;
      add("Aantal holders", pts, `Ongeveer ${c}${holderInfo.capped ? "+" : ""} holders.`);
    }

    score = Math.min(score, 100);
    const level = score >= 60 ? "high" : score >= 30 ? "medium" : "low";

    // 5. Bubble map (eerste versie: grootte per holder, nog zonder verbindingen)
    const bubbles = topHolders
      ? topHolders.map((h) => ({
          id: h.owner || h.tokenAccount,
          percent: h.percent
        }))
      : null;

    const result = {
      mint: mint,
      name: asset?.content?.metadata?.name || null,
      symbol: asset?.content?.metadata?.symbol || null,
      decimals: decimals,
      supply: supply,
      price: asset?.token_info?.price_info?.price_per_token ?? null,
      image:
        asset?.content?.links?.image ||
        asset?.content?.files?.[0]?.uri ||
        null,
      website:
        asset?.content?.links?.external_url ||
        asset?.content?.links?.website ||
        null,
      links: asset?.content?.links || null,
      top10Percent: top10Percent,
      topHolders: topHolders,
      holders: holderInfo ? holderInfo.count : null,
      holdersCapped: holderInfo ? holderInfo.capped : null,
      tx24h: activity ? activity.count24h : null,
      tx24hCapped: activity ? activity.capped : null,
      recentTransactions: activity ? activity.recent : null,
      risk: { score, level, signals },
      bubbles: bubbles
    };

    return res.status(200).json(result);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error while scanning token" });
  }
};
