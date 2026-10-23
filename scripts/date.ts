const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

export function toDate(value: string): string | undefined {
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  if (iso) return iso;
  const written = /(?:^|[\s,])(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\b/.exec(value);
  const month = written ? MONTHS[written[2].toLowerCase()] : undefined;
  const day = written ? Number(written[1]) : 0;
  if (written && month && day >= 1 && day <= 31) {
    return `${written[3]}-${month}-${String(day).padStart(2, "0")}`;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString().slice(0, 10);
}
