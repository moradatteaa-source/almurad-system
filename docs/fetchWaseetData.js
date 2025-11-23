import fs from "fs";
import fetch from "node-fetch";

const BASE_URL = "https://api.alwaseet-iq.net/v1/merchant";

async function getCities() {
  const res = await fetch(`${BASE_URL}/citys`);
  const data = await res.json();
  if (!data.status) throw new Error("فشل جلب المدن");
  return data.data;
}

async function getRegions(cityId) {
  const res = await fetch(`${BASE_URL}/regions?city_id=${cityId}`);
  const data = await res.json();
  if (!data.status) return [];
  return data.data.map(r => ({ id: r.id, region_name: r.region_name, city_id: cityId }));
}

async function main() {
  console.log("⏳ جاري جلب المحافظات من الوسيط...");
  const cities = await getCities();

  // حفظ المحافظات في ملف
  fs.writeFileSync("./waseetCities.js", `export const waseetCities = ${JSON.stringify(cities, null, 2)};`);
  console.log(`✅ تم حفظ ${cities.length} محافظة في waseetCities.js`);

  let allRegions = [];

  for (const city of cities) {
    console.log(`➡️ جلب مناطق ${city.city_name} (ID: ${city.id})`);
    const regions = await getRegions(city.id);
    allRegions = allRegions.concat(regions);
  }

  fs.writeFileSync("./waseetRegions.js", `export const waseetRegions = ${JSON.stringify(allRegions, null, 2)};`);
  console.log(`✅ تم حفظ ${allRegions.length} منطقة في waseetRegions.js`);
  console.log("🎉 العملية اكتملت بنجاح");
}

main().catch(err => console.error("❌ خطأ:", err));
