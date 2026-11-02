import SwiftUI
import UIKit

// #29: mirrors packages/tokens/src/tokens.json (dark and light). Keep in sync:
// packages/tokens/tests/ios-theme.test.ts fails CI if a value drifts.
enum Theme {
    // Backgrounds
    static let bgBase = Color.adaptive(dark: 0x12161c, light: 0xf3f5f8)
    static let bgSurface = Color.adaptive(dark: 0x171c23, light: 0xffffff)
    static let bgElevated = Color.adaptive(dark: 0x1e242d, light: 0xeef1f5)
    static let bgInput = Color.adaptive(dark: 0x0f1318, light: 0xffffff)
    static let bgDeep = Color.adaptive(dark: 0x0d1014, light: 0xe9edf2)
    static let card = Color.adaptive(dark: 0x12161c, light: 0xffffff, darkOpacity: 0.96, lightOpacity: 0.96)

    // Accent
    static let accent = Color.adaptive(dark: 0xf7931a, light: 0x8a4f08)
    static let accentHover = Color.adaptive(dark: 0xffad4a, light: 0x7a450a)
    /// Text/icons on an accent fill (buttons, selected rows).
    static let onAccent = Color.adaptive(dark: 0x0d1014, light: 0xffffff)
    static let accentSecondary = Color.adaptive(dark: 0x5aa9ff, light: 0x1f5bb5)

    // Text
    static let textPrimary = Color.adaptive(dark: 0xe8ecf1, light: 0x10151c)
    static let textSecondary = Color.adaptive(dark: 0xaab3c0, light: 0x46505e)
    static let textMuted = Color.adaptive(dark: 0x8b96a4, light: 0x596470)

    // Status
    static let green = Color.adaptive(dark: 0x3ecf8e, light: 0x0f6e3a)
    static let red = Color.adaptive(dark: 0xf0616d, light: 0xc23442)
    static let yellow = Color.adaptive(dark: 0xe9b949, light: 0x7d5205)

    // Border (cool grey, matches the desktop tokens)
    static let border = Color.adaptive(dark: 0xaab3c0, light: 0x0d1014, darkOpacity: 0.10, lightOpacity: 0.10)
    static let borderStrong = Color.adaptive(dark: 0xaab3c0, light: 0x0d1014, darkOpacity: 0.18, lightOpacity: 0.16)
    // Edges of inputs and other controls, and focus rings: 3:1 on every background (WCAG 1.4.11).
    static let borderControl = Color.adaptive(dark: 0x6b7684, light: 0x7c8591)
    static let focusRing = Color.adaptive(dark: 0xf7931a, light: 0x8a4f08)
    /// #25: selected-text background (the desktop Monaco selection colour).
    static let selection = Color.adaptive(dark: 0x2a2114, light: 0xfce4c4)
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
