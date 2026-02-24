import SwiftUI

enum Theme {
    // Backgrounds
    static let bgBase = Color(hex: 0x2f2f2d)
    static let bgSurface = Color(hex: 0x3a3a37)
    static let bgElevated = Color(hex: 0x454542)
    static let bgInput = Color(hex: 0x262624)
    static let bgDeep = Color(hex: 0x1a1a18)

    // Accent
    static let accent = Color(hex: 0xc17850)
    static let accentHover = Color(hex: 0xd4895f)
    static let accentSecondary = Color(hex: 0x4a90d9)

    // Text
    static let textPrimary = Color(hex: 0xf7f5f0)
    static let textSecondary = Color(hex: 0xb8b0a4)
    static let textMuted = Color(hex: 0x8a8478)

    // Status
    static let green = Color(hex: 0x4ade80)
    static let red = Color(hex: 0xf87171)
    static let yellow = Color(hex: 0xfbbf24)

    // Border
    static let border = Color.white.opacity(0.08)
    static let borderStrong = Color.white.opacity(0.15)
}

extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }
}
