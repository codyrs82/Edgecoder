import SwiftUI
import UIKit

// #29: mirrors packages/tokens/src/tokens.json (dark and light). Keep in sync:
// packages/tokens/tests/ios-theme.test.ts fails CI if a value drifts.
enum Theme {
    // Backgrounds
    static let bgBase = Color.adaptive(dark: 0x2f2f2d, light: 0xf7f5f0)
    static let bgSurface = Color.adaptive(dark: 0x3a3a37, light: 0xffffff)
    static let bgElevated = Color.adaptive(dark: 0x454542, light: 0xefece6)
    static let bgInput = Color.adaptive(dark: 0x262624, light: 0xffffff)
    static let bgDeep = Color.adaptive(dark: 0x1a1a18, light: 0xebe7e0)
    static let card = Color.adaptive(dark: 0x3a3a37, light: 0xffffff, darkOpacity: 0.96, lightOpacity: 0.96)

    // Accent
    static let accent = Color.adaptive(dark: 0xc17850, light: 0xa65a33)
    static let accentHover = Color.adaptive(dark: 0xd4895f, light: 0x8f4a27)
    static let accentSecondary = Color.adaptive(dark: 0x4a90d9, light: 0x2a64a8)

    // Text
    static let textPrimary = Color.adaptive(dark: 0xf7f5f0, light: 0x1f1f1d)
    static let textSecondary = Color.adaptive(dark: 0xb8b0a4, light: 0x57524a)
    static let textMuted = Color.adaptive(dark: 0x8a8478, light: 0x6b665c)

    // Status
    static let green = Color.adaptive(dark: 0x4ade80, light: 0x15803d)
    static let red = Color.adaptive(dark: 0xf87171, light: 0xb91c1c)
    static let yellow = Color.adaptive(dark: 0xfbbf24, light: 0xa16207)

    // Border (warm grey, not white, to match the desktop tokens)
    static let border = Color.adaptive(dark: 0xd6ccc2, light: 0x2f2f2d, darkOpacity: 0.08, lightOpacity: 0.10)
    static let borderStrong = Color.adaptive(dark: 0xd6ccc2, light: 0x2f2f2d, darkOpacity: 0.15, lightOpacity: 0.18)
}

/// #151: System / Light / Dark, matching the desktop's theme setting (desktop/src/lib/theme.ts).
/// Lives in Theme.swift so no Xcode project change is needed.
enum AppearancePreference: String, CaseIterable, Identifiable {
    case system, light, dark

    /// Same key name as the desktop. Dark stays the default until light mode has had a visual check.
    static let storageKey = "edgecoder-theme"
    static let defaultValue: AppearancePreference = .dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    /// nil = follow the system setting.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// Unknown or missing stored values fall back to the default.
    static func from(_ raw: String?) -> AppearancePreference {
        raw.flatMap(AppearancePreference.init(rawValue:)) ?? defaultValue
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: opacity)
    }

    /// Resolves per trait collection, so it follows the system light/dark setting.
    static func adaptive(dark: UInt32, light: UInt32, darkOpacity: Double = 1.0, lightOpacity: Double = 1.0) -> Color {
        // `.unspecified` resolves to light; the app always sets a scheme via AppearancePreference.
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(hex: dark, alpha: darkOpacity)
                : UIColor(hex: light, alpha: lightOpacity)
        })
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: Double = 1.0) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green: CGFloat((hex >> 8) & 0xFF) / 255.0,
            blue: CGFloat(hex & 0xFF) / 255.0,
            alpha: CGFloat(alpha)
        )
    }
}
