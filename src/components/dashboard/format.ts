export const money = (value: number | null | undefined) =>
  value == null ? "--" : new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 2,
  }).format(value);

export const decimal = (value: number | null | undefined) =>
  value == null ? "--" : value.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

export const timeLabel = (time: number, daily = false) =>
  new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    ...(daily ? { day: "2-digit", month: "short" } : { hour: "2-digit", minute: "2-digit", hour12: false }),
  }).format(new Date(time * 1000));
