import type { SVGProps } from "react";

type IconName = "bolt" | "sun" | "moon" | "link" | "arrow" | "chart" | "shield" | "close" | "refresh" | "logout";
const paths: Record<IconName, string> = {
  bolt: "m13 2-9 12h7l-1 8 10-12h-7l1-8Z",
  sun: "M12 3V1m0 22v-2M3 12H1m22 0h-2M4.2 4.2 2.8 2.8m18.4 18.4-1.4-1.4M4.2 19.8l-1.4 1.4M21.2 2.8l-1.4 1.4M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z",
  moon: "M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10Z",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2m3 6a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2",
  arrow: "M7 17 17 7M7 7h10v10",
  chart: "M4 3v18h17M8 16v-4m5 4V8m5 8V5",
  shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
  close: "m6 6 12 12M6 18 18 6",
  refresh: "M20 7v5h-5M4 17v-5h5m-4-3a7 7 0 0 1 12-4l3 3M4 16l3 3a7 7 0 0 0 12-4",
  logout: "M9 4H4v16h5m5-13 5 5-5 5m-6-5h12",
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
