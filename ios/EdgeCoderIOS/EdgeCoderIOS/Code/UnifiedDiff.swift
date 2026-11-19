import Foundation

/// A simple line diff of a file's before and after text, shown as unified-diff hunks.
enum UnifiedDiff {
    enum Kind: Equatable { case context, added, removed, hunk }

    struct Line: Equatable, Identifiable {
        let id: Int
        let kind: Kind
        let text: String
        /// Line numbers in the old and new file (nil where the line isn't in that file).
        let old: Int?
        let new: Int?

        /// "+line", "-line", " line", or the "@@ ... @@" header.
        var rendered: String {
            switch kind {
            case .added: return "+" + text
            case .removed: return "-" + text
            case .context: return " " + text
            case .hunk: return text
            }
        }
    }

    /// Above this many old x new lines the LCS table is skipped: everything old is removed, everything new added.
    static let maxCells = 2_000_000

    static func lines(of text: String?) -> [String] {
        guard let text, !text.isEmpty else { return [] }
        var parts = text.components(separatedBy: "\n")
        if parts.last == "" { parts.removeLast() }
        return parts
    }

    private enum Op { case same(Int, Int), add(Int), remove(Int) }

    /// Edit script from a longest-common-subsequence table (fine for the Mac's 32 KB-per-file cap).
    private static func script(_ a: [String], _ b: [String]) -> [Op] {
        let n = a.count, m = b.count
        if n == 0 { return (0..<m).map { .add($0) } }
        if m == 0 { return (0..<n).map { .remove($0) } }
        // Trim the common start and end first: most edits touch a few lines of a long file.
        var start = 0
        while start < n, start < m, a[start] == b[start] { start += 1 }
        var endA = n, endB = m
        while endA > start, endB > start, a[endA - 1] == b[endB - 1] { endA -= 1; endB -= 1 }
        var ops: [Op] = (0..<start).map { .same($0, $0) }
        let ca = endA - start, cb = endB - start
        if ca * cb > maxCells {
            ops += (start..<endA).map { .remove($0) }
            ops += (start..<endB).map { .add($0) }
        } else if ca > 0 || cb > 0 {
            // lcs[i][j]: LCS length of a[start+i..<endA] and b[start+j..<endB].
            var lcs = [[Int32]](repeating: [Int32](repeating: 0, count: cb + 1), count: ca + 1)
            if ca > 0 && cb > 0 {
                for i in stride(from: ca - 1, through: 0, by: -1) {
                    for j in stride(from: cb - 1, through: 0, by: -1) {
                        lcs[i][j] = a[start + i] == b[start + j] ? lcs[i + 1][j + 1] + 1 : max(lcs[i + 1][j], lcs[i][j + 1])
                    }
                }
            }
            var i = 0, j = 0
            while i < ca || j < cb {
                if i < ca, j < cb, a[start + i] == b[start + j] {
                    ops.append(.same(start + i, start + j)); i += 1; j += 1
                } else if i < ca, j == cb || lcs[i + 1][j] >= lcs[i][j + 1] {
                    // Removals before additions, as `diff -u` prints them.
                    ops.append(.remove(start + i)); i += 1
                } else {
                    ops.append(.add(start + j)); j += 1
                }
            }
        }
        ops += (0..<(n - endA)).map { .same(endA + $0, endB + $0) }
        return ops
    }

    /// Unified-diff lines with `context` unchanged lines around each change, grouped into hunks.
    static func diff(before: String?, after: String?, context: Int = 3) -> [Line] {
        let a = lines(of: before), b = lines(of: after)
        let ops = script(a, b)
        let changed = ops.indices.filter { if case .same = ops[$0] { return false } else { return true } }
        guard !changed.isEmpty else { return [] }

        // Ranges of ops to show: each change plus context, merged when they touch.
        var ranges: [ClosedRange<Int>] = []
        for idx in changed {
            let r = max(0, idx - context)...min(ops.count - 1, idx + context)
            if let last = ranges.last, r.lowerBound <= last.upperBound + 1 {
                ranges[ranges.count - 1] = last.lowerBound...max(last.upperBound, r.upperBound)
            } else {
                ranges.append(r)
            }
        }

        var out: [Line] = []
        var nextId = 0
        func emit(_ kind: Kind, _ text: String, _ old: Int?, _ new: Int?) {
            out.append(Line(id: nextId, kind: kind, text: text, old: old, new: new))
            nextId += 1
        }
        for range in ranges {
            let slice = ops[range]
            var oldStart: Int?, newStart: Int?, oldCount = 0, newCount = 0
            for op in slice {
                switch op {
                case .same(let i, let j):
                    oldStart = oldStart ?? i; newStart = newStart ?? j; oldCount += 1; newCount += 1
                case .remove(let i):
                    oldStart = oldStart ?? i; oldCount += 1
                case .add(let j):
                    newStart = newStart ?? j; newCount += 1
                }
            }
            // Unified diff numbers lines from 1; an empty side starts at 0.
            let os = oldCount == 0 ? (oldStart ?? 0) : (oldStart ?? 0) + 1
            let ns = newCount == 0 ? (newStart ?? 0) : (newStart ?? 0) + 1
            emit(.hunk, "@@ -\(os),\(oldCount) +\(ns),\(newCount) @@", nil, nil)
            for op in slice {
                switch op {
                case .same(let i, let j): emit(.context, a[i], i + 1, j + 1)
                case .remove(let i): emit(.removed, a[i], i + 1, nil)
                case .add(let j): emit(.added, b[j], nil, j + 1)
                }
            }
        }
        return out
    }

    /// Lines added and removed ("+12 -3").
    static func counts(_ lines: [Line]) -> (added: Int, removed: Int) {
        (lines.filter { $0.kind == .added }.count, lines.filter { $0.kind == .removed }.count)
    }
}
