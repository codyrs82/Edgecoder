import Combine
import XCTest

/// PR5 Code mode: decoding the portal's and the Mac's answers, error wording, the drawer's
/// grouping, and the unified diff.
@MainActor
final class CodeModeTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    // MARK: - Machines

    func testDecodesTheMachineFixture() throws {
        let machines = try decode(CodeMachinesResponse.self, CodeFixture.machinesJSON).machines
        XCTAssertEqual(machines.map(\.name), ["Cody's MacBook Pro", "Mac Studio", "Mac mini", "MacBook Air"])
        let mbp = machines[0]
        XCTAssertEqual(mbp.agentId, "agent-mbp-7f3a")
        XCTAssertEqual(mbp.availability, .ready)
        XCTAssertTrue(mbp.canDrive)
        XCTAssertEqual(mbp.projects.count, 3)
        XCTAssertEqual(mbp.projects[0].branch, "ios-code-mode")
        XCTAssertNil(mbp.projects[2].branch)
        XCTAssertEqual(mbp.sessions.count, 3)
        XCTAssertEqual(mbp.sessions[0].status, .waiting)
        XCTAssertEqual(mbp.sessions[0].pendingApprovals, 1)
        XCTAssertEqual(mbp.sessions[0].startedFrom, "phone")
        XCTAssertEqual(mbp.sessions[0].statusLine, "Waiting for you · 1 approval waiting")
        XCTAssertEqual(machines[1].availability, .viewOnly)
        XCTAssertFalse(machines[1].canDrive)
        XCTAssertTrue(machines[1].canRead)
        XCTAssertEqual(machines[2].availability, .off)
        XCTAssertEqual(machines[3].availability, .offline, "offline wins over controls: on")
        XCTAssertNil(machines[3].updatedAtMs)
    }

    func testMachinesDecodeLeniently() throws {
        let json = #"""
        {"machines":[
          {"agentId":"a1","online":true,"controls":"sideways","projects":[{"name":"no id"}, {"projectId":"p1"}],
           "sessions":[{"sessionId":"s1","status":"thinking","title":""}, {"title":"no id"}], "extra":{"x":1}},
          {"name":"no agent id"},
          "garbage"
        ]}
        """#
        let machines = try decode(CodeMachinesResponse.self, json).machines
        XCTAssertEqual(machines.count, 1, "items that don't decode are skipped")
        let m = machines[0]
        XCTAssertEqual(m.name, "Computer")
        XCTAssertEqual(m.controls, .off, "an unknown controls value is treated as off")
        XCTAssertEqual(m.projects.map(\.projectId), ["p1"])
        XCTAssertEqual(m.sessions.count, 1)
        XCTAssertEqual(m.sessions[0].status, .idle)
        XCTAssertEqual(m.sessions[0].title, "Untitled session")
        XCTAssertEqual(m.sessions[0].startedFrom, "mac")
        XCTAssertTrue(try decode(CodeMachinesResponse.self, "{}").machines.isEmpty)
    }

    func testMachineHints() {
        let off = CodeMachine(agentId: "a", name: "A", online: true, controls: .off)
        let view = CodeMachine(agentId: "b", name: "B", online: true, controls: .view)
        let gone = CodeMachine(agentId: "c", name: "C", online: false, controls: .on)
        let on = CodeMachine(agentId: "d", name: "D", online: true, controls: .on)
        XCTAssertEqual(CodeMachineCopy.status(off), "Off")
        XCTAssertEqual(CodeMachineCopy.status(view), "View only")
        XCTAssertEqual(CodeMachineCopy.status(gone), "Offline")
        XCTAssertTrue(CodeMachineCopy.hint(off)!.contains("Code from your phone"))
        XCTAssertTrue(CodeMachineCopy.hint(view)!.contains("Code from your phone"))
        XCTAssertNil(CodeMachineCopy.hint(on))
    }

    // MARK: - Snapshot

    func testDecodesTheSnapshotFixture() throws {
        let s = try decode(CodeSessionSnapshot.self, CodeFixture.snapshotJSON)
        XCTAssertEqual(s.session.title, "Fix flaky wallet test")
        XCTAssertEqual(s.session.projectName, "Edgecoder")
        XCTAssertEqual(s.session.mode, "ask")
        XCTAssertEqual(s.seq, 42)
        XCTAssertEqual(s.status, .waiting, "a pending approval means waiting")
        XCTAssertEqual(s.running?.steps.count, 3)
        XCTAssertEqual(s.running?.steps.last?.status, "pending")
        XCTAssertEqual(s.pending.count, 1)
        let p = s.pending[0]
        XCTAssertEqual(p.callId, "call_9")
        XCTAssertEqual(p.tool, "run_shell")
        XCTAssertTrue(p.approvable)
        XCTAssertEqual(p.fullText, "npm test -- src/wallet/ledger.test.ts --reporter=verbose", "the card shows the whole command")
        XCTAssertEqual(s.tail.map(\.role), ["note", "user", "assistant", "user"])
        let reply = s.tail[2]
        XCTAssertEqual(reply.steps.map(\.tool), ["grep", "read_file", "edit_file"])
        XCTAssertEqual(reply.changedFiles, ["<project>/src/wallet/ledger.test.ts"])
        XCTAssertEqual(s.lastTurnId, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d")
        XCTAssertFalse(s.awaitingPlanApproval)
    }

    func testSnapshotStatusAndPlanApproval() throws {
        let idlePlan = #"""
        {"session":{"id":"s","mode":"plan","running":false},"running":null,"pending":[],"tail":[
          {"id":"1","role":"user","content":"plan it"},
          {"id":"2","role":"assistant","content":"1. do x","plan":true,"turnId":"t1"}]}
        """#
        let s = try decode(CodeSessionSnapshot.self, idlePlan)
        XCTAssertEqual(s.status, .idle)
        XCTAssertTrue(s.awaitingPlanApproval)
        XCTAssertTrue(s.queue.isEmpty)

        let running = #"{"session":{"running":true},"tail":[{"id":"1","role":"assistant","turnId":"t1","undone":true}]}"#
        let r = try decode(CodeSessionSnapshot.self, running)
        XCTAssertEqual(r.status, .running)
        XCTAssertNil(r.lastTurnId, "an undone turn isn't undone again")
        XCTAssertEqual(r.session.title, "Untitled session")
    }

    func testApprovalTooLongForThePhone() throws {
        let json = #"{"callId":"c1","tool":"run_shell","detail":"long","command":"echo …","approvable":false,"message":"This command is too long to check on the phone. Approve it on the Mac."}"#
        let a = try decode(CodeApproval.self, json)
        XCTAssertFalse(a.approvable)
        XCTAssertEqual(a.message, "This command is too long to check on the phone. Approve it on the Mac.")
        let edit = try decode(CodeApproval.self, #"{"callId":"c2","tool":"edit_file","detail":"<project>/a.ts"}"#)
        XCTAssertEqual(edit.fullText, "<project>/a.ts")
        XCTAssertFalse(edit.approvable, "missing approvable: approve on the Mac")
    }

    // MARK: - Changes and the diff

    func testDecodesTheChangesFixture() throws {
        let c = try decode(CodeChanges.self, CodeFixture.changesJSON)
        XCTAssertEqual(c.total, 2)
        XCTAssertFalse(c.truncated)
        XCTAssertEqual(c.items.map(\.kind), ["Modified", "Added"])
        XCTAssertNil(c.items[1].before)
        XCTAssertFalse(c.items[0].cut)
    }

    func testUnifiedDiffOfAnEdit() {
        let before = "a\nb\nc\nd\ne\nf\ng\nh\n"
        let after = "a\nb\nc\nD\ne\nf\ng\nh\ni\n"
        let lines = UnifiedDiff.diff(before: before, after: after, context: 1)
        XCTAssertEqual(lines.map(\.rendered), [
            "@@ -3,3 +3,3 @@", " c", "-d", "+D", " e",
            "@@ -8,1 +8,2 @@", " h", "+i",
        ])
        let counts = UnifiedDiff.counts(lines)
        XCTAssertEqual(counts.added, 2)
        XCTAssertEqual(counts.removed, 1)
        XCTAssertEqual(lines[2].old, 4)
        XCTAssertNil(lines[2].new)
        XCTAssertEqual(lines[3].new, 4)
    }

    func testUnifiedDiffOfANewAndADeletedFile() {
        let added = UnifiedDiff.diff(before: nil, after: "x\ny\n")
        XCTAssertEqual(added.map(\.rendered), ["@@ -0,0 +1,2 @@", "+x", "+y"])
        let deleted = UnifiedDiff.diff(before: "x\n", after: nil)
        XCTAssertEqual(deleted.map(\.rendered), ["@@ -1,1 +0,0 @@", "-x"])
        XCTAssertTrue(UnifiedDiff.diff(before: "same\n", after: "same\n").isEmpty)
    }

    func testUnifiedDiffOfTheFixtureFile() throws {
        let file = try decode(CodeChanges.self, CodeFixture.changesJSON).items[0]
        let lines = UnifiedDiff.diff(before: file.before, after: file.after)
        let counts = UnifiedDiff.counts(lines)
        XCTAssertEqual(counts.added, 4)
        XCTAssertEqual(counts.removed, 1)
        XCTAssertEqual(lines.first?.kind, .hunk)
    }

    // MARK: - Command results and errors

    func testCommandOutcomeUnwrapsTheMacsData() throws {
        let done = try decode(CodeCommandState.self, #"{"status":"done","result":{"status":"done","data":{"sessionId":"s9"}}}"#)
        let created = try done.outcome().get().decode(CodeCreated.self)
        XCTAssertEqual(created.sessionId, "s9")

        let bare = try decode(CodeCommandState.self, #"{"status":"done","result":{"sessionId":"s8"}}"#)
        XCTAssertEqual(try bare.outcome().get().decode(CodeCreated.self).sessionId, "s8", "a portal that passes only data through")

        let refused = try decode(CodeCommandState.self, #"{"status":"done","result":{"status":"refused","error":"auto_on_mac","message":"Auto mode is turned on from the Mac."}}"#)
        XCTAssertEqual(refused.outcome().failureValue?.sentence, "Auto mode is turned on from the Mac.")

        let failed = try decode(CodeCommandState.self, #"{"status":"failed","error":"approve_on_mac"}"#)
        XCTAssertEqual(failed.outcome().failureValue?.sentence, "This command is too long to check on the phone. Approve it on the Mac.")

        let failedRelay = try decode(CodeCommandState.self, #"{"status":"failed","error":"relay_off"}"#)
        XCTAssertEqual(failedRelay.outcome().failureValue, .relayOff)

        let unreachable = try decode(CodeCommandState.self, #"{"status":"failed","error":"provider_unreachable"}"#)
        XCTAssertTrue(unreachable.outcome().failureValue!.sentence.contains("isn't answering"))

        let expired = try decode(CodeCommandState.self, #"{"status":"expired"}"#)
        XCTAssertEqual(expired.outcome().failureValue, .expired)
        XCTAssertFalse(try decode(CodeCommandState.self, #"{"status":"pending"}"#).isFinished)
    }

    func testErrorCodesMapToPlainSentences() {
        XCTAssertEqual(CodeError.from(code: "agent_not_connected", message: nil, status: 409), .offline)
        XCTAssertEqual(CodeError.from(code: "relay_off", message: nil, status: 409), .relayOff)
        XCTAssertEqual(CodeError.from(code: "view_only", message: nil, status: 409), .viewOnly)
        XCTAssertEqual(CodeError.from(code: "rate_limited", message: nil, status: 429), .rateLimited)
        XCTAssertEqual(CodeError.from(code: "not_your_machine", message: nil, status: 403), .notYourMachine)
        XCTAssertEqual(CodeError.from(code: nil, message: nil, status: 401), .signedOut)
        XCTAssertEqual(CodeError.from(code: "unknown_command", message: nil, status: 404), .expired)
        XCTAssertEqual(CodeError.from(code: nil, message: nil, status: 429), .rateLimited, "the status alone is enough")

        XCTAssertTrue(CodeError.offline.sentence.contains("offline"))
        XCTAssertEqual(CodeError.relayOff.sentence, "Code from your phone looks off on this computer, or it just reconnected. Try again in a minute, or turn on 'Code from your phone' in the EdgeCoder desktop app.")
        XCTAssertTrue(CodeError.viewOnly.sentence.contains("View only"))
        XCTAssertTrue(CodeError.rateLimited.sentence.contains("Wait a few seconds"))
        XCTAssertEqual(CodeError.notYourMachine.sentence, "That computer belongs to another account.")
        XCTAssertTrue(CodeError.expired.sentence.contains("Try again"))
    }

    func testAServerMessageIsPreferredExceptForRelayOff() {
        let e = CodeError.from(code: "view_only", message: "This Mac is set to view only.", status: 409)
        XCTAssertEqual(e.kind, .viewOnly)
        XCTAssertEqual(e.sentence, "This Mac is set to view only.")
        let relay = CodeError.from(code: "relay_off", message: "relay is off", status: 409)
        XCTAssertEqual(relay, .relayOff, "a just-restarted coordinator says relay_off for a Mac that is on")
        XCTAssertEqual(CodeError.from(code: "rate_limited", message: "  ", status: 429), .rateLimited, "a blank message is ignored")
    }

    func testPortalErrorBodies() {
        let body = Data(#"{"error":"view_only","message":null}"#.utf8)
        XCTAssertEqual(PortalCodeBackend.error(status: 409, data: body), .viewOnly)
        XCTAssertEqual(PortalCodeBackend.error(status: 409, data: Data("not json".utf8)), .offline)
        XCTAssertEqual(PortalCodeBackend.error(status: 401, data: Data()), .signedOut)
    }

    // MARK: - Drawer

    func testDrawerGroupsSessionsByMachineAndProject() throws {
        let machines = try decode(CodeMachinesResponse.self, CodeFixture.machinesJSON).machines
        let sections = CodeDrawerSource.sections(machines, query: "")
        XCTAssertEqual(sections.map(\.title), [
            "Cody's MacBook Pro · Edgecoder",
            "Cody's MacBook Pro · portfolio-site",
            "Mac Studio · ml-pipeline",
        ], "machines in portal order; inside one, the project with the newest session first")
        XCTAssertEqual(sections[0].rows.map(\.title), ["Fix flaky wallet test", "Add dark mode to settings"], "newest first")
        XCTAssertEqual(sections[0].rows[0].id, "agent-mbp-7f3a/3f1c2a4e-8b7d-4c1e-9a2f-5d6e7f8a9b0c")
        XCTAssertEqual(sections[0].rows[0].subtitle, "Waiting for you · 1 approval waiting")
        XCTAssertNotNil(sections[0].rows[0].date)
    }

    func testDrawerSearchAndOfflineMachines() {
        let m = CodeMachine(agentId: "a", name: "Laptop", online: false, controls: .on,
                            projects: [CodeProject(projectId: "p", name: "app")],
                            sessions: [
                                CodeSessionSummary(sessionId: "s1", projectId: "p", title: "Fix login", updatedAtMs: 2),
                                CodeSessionSummary(sessionId: "s2", projectId: "gone", title: "Old thing", updatedAtMs: 1),
                            ])
        let all = CodeDrawerSource.sections([m], query: "")
        XCTAssertEqual(all.map(\.title), ["Laptop · app", "Laptop · Other project"])
        XCTAssertEqual(all[0].rows[0].subtitle, "Offline")
        XCTAssertEqual(CodeDrawerSource.sections([m], query: "LOGIN").flatMap(\.rows).map(\.title), ["Fix login"])
        XCTAssertEqual(CodeDrawerSource.sections([m], query: "laptop").flatMap(\.rows).count, 2, "the computer's name matches too")
        XCTAssertTrue(CodeDrawerSource.sections([m], query: "zzz").isEmpty)
    }

    func testDrawerRowIdsRoundTrip() {
        let id = CodeDrawerSource.rowId(agentId: "agent-1", sessionId: "s-2")
        let parsed = CodeDrawerSource.parse(id)
        XCTAssertEqual(parsed?.agentId, "agent-1")
        XCTAssertEqual(parsed?.sessionId, "s-2")
        XCTAssertNil(CodeDrawerSource.parse("nothing"))
        XCTAssertNil(CodeDrawerSource.parse("a/"))
    }

    func testDrawerSourceFollowsThePublisher() {
        let subject = CurrentValueSubjectBox()
        let src = CodeDrawerSource(machines: subject.publisher)
        subject.send([CodeMachine(agentId: "a", name: "A", online: true, controls: .on,
                                  projects: [CodeProject(projectId: "p", name: "proj")],
                                  sessions: [CodeSessionSummary(sessionId: "s", projectId: "p", title: "T")])])
        let exp = expectation(description: "published")
        DispatchQueue.main.async { exp.fulfill() }
        wait(for: [exp], timeout: 1)
        XCTAssertEqual(src.sections(matching: "").flatMap(\.rows).map(\.id), ["a/s"])
    }
}

private final class CurrentValueSubjectBox {
    private let subject = CurrentValueSubject<[CodeMachine], Never>([])
    var publisher: AnyPublisher<[CodeMachine], Never> { subject.eraseToAnyPublisher() }
    func send(_ m: [CodeMachine]) { subject.send(m) }
}

private extension Result {
    var failureValue: Failure? {
        if case .failure(let f) = self { return f }
        return nil
    }
}
