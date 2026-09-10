import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#FFFFFF",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "80px",
          border: "16px solid #000000",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 120, fontWeight: 900, color: "#000000", letterSpacing: -2 }}>
          DRIMER
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 16,
            fontSize: 34,
            fontWeight: 800,
            color: "#000000",
            background: "#C6FF00",
            padding: "8px 20px",
            border: "4px solid #000000",
          }}
        >
          THE CALIBRATION LAYER
        </div>
        <div style={{ display: "flex", marginTop: 32, fontSize: 26, color: "#000000", maxWidth: 940 }}>
          Self-calibrating Bayesian agent trading BTC/ETH Event Contracts on Somnia. Every prediction logged, whether or not it trades.
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 40 }}>
          <div style={{ display: "flex", fontSize: 22, fontWeight: 700, border: "3px solid #000000", padding: "8px 16px", color: "#000000" }}>
            SOMNIA × DREAMDEX
          </div>
          <div style={{ display: "flex", fontSize: 22, fontWeight: 700, border: "3px solid #000000", padding: "8px 16px", background: "#FFE600", color: "#000000" }}>
            SHANNON TESTNET
          </div>
        </div>
      </div>
    ),
    { ...size }
  );
}
