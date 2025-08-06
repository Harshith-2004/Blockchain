// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

import "./ResearchRegistry.sol";
import "./AppointmentManager.sol";
import "./PatientWallet.sol";

contract DataEscrow {
    IERC20             public immutable stablecoin;
    ResearchRegistry   public immutable researchers;
    AppointmentManager public immutable appts;
    PatientWallet      public immutable wallet;
    address            public immutable arbitrator;

    uint256 public constant BASE_STAKE_PCT   = 100;  // patients stake 100%
    uint256 public constant MIN_STAKE_PCT    = 100;  // floor at 100%
    uint256 public constant REDUCTION_STEP   = 5;    // reward on good
    uint256 public constant PENALTY_STEP     = 10;   // penalty on dispute
    uint256 public constant REVIEW_PERIOD    = 7 days;

    enum Status { Pending, Fulfilled, Completed, Disputed, Resolved }

    struct Request {
        address researcher;
        address patient;
        uint256 amount;
        uint256 patientStake;
        uint256 createdAt;
        Status  status;
        bool    insurerDecision; // true = researcher wins
    }
    Request[] public requests;
    mapping(address => uint256) private stakePct;

    event RequestInitiated(uint256 indexed id, address researcher, address patient, uint256 amount, bytes32 dataHash);
    event DataFulfilled(uint256 indexed id, bytes32 dataHash);
    event RequestAutoCompleted(uint256 indexed id);
    event DisputeFlagged(uint256 indexed id);
    event DisputeResolved(uint256 indexed id, bool researcherWins);
    event StakePctUpdated(address indexed patient, uint256 newPct);

    constructor(
        address _stablecoin,
        address _researchReg,
        address _apptMgr,
        address payable _wallet,
        address _arbitrator
    ) {
        stablecoin   = IERC20(_stablecoin);
        researchers  = ResearchRegistry(_researchReg);
        appts        = AppointmentManager(_apptMgr);
        wallet       = PatientWallet(_wallet);
        arbitrator   = _arbitrator;
    }

    function _getStakePct(address p) internal view returns (uint256) {
        uint256 v = stakePct[p];
        return v == 0 ? BASE_STAKE_PCT : v;
    }

    /// Researcher starts request by depositing `amount`, patient stakes pct%
    function initiateRequest(
        address patient,
        uint256 amount,
        bytes32 dataHash
    ) external {
        require(researchers.isResearcher(msg.sender),    "Not approved researcher");
        require(appts.isAuthorized(patient, msg.sender),"No OP consent");
        require(amount > 0,                              "Amount>0");

        uint256 pct  = _getStakePct(patient);
        uint256 pstk = amount * pct / 100;

        // researcher deposit
        require(stablecoin.transferFrom(msg.sender, address(this), amount), "Res deposit failed");
        // patient stake
        require(stablecoin.transferFrom(patient,   address(this), pstk),   "Patient stake failed");

        requests.push(Request({
            researcher:      msg.sender,
            patient:         patient,
            amount:          amount,
            patientStake:    pstk,
            createdAt:       block.timestamp,
            status:          Status.Pending,
            insurerDecision: false
        }));
        emit RequestInitiated(requests.length - 1, msg.sender, patient, amount, dataHash);
    }

    /// Patient fulfills with data; moves to Fulfilled
    function fulfillData(
        uint256 id,
        bytes32 dataHash,
        string calldata uri
    ) external {
        Request storage r = requests[id];
        require(msg.sender == r.patient,      "Only patient");
        require(r.status == Status.Pending,   "Wrong status");

        wallet.addRecord(dataHash, uri);
        r.status = Status.Fulfilled;
        emit DataFulfilled(id, dataHash);
    }

    /// Auto‐complete after window if no dispute: patient gets researcher deposit + stake back
    function autoComplete(uint256 id) external {
        Request storage r = requests[id];
        require(r.status == Status.Fulfilled,                         "Not fulfilled");
        require(block.timestamp >= r.createdAt + REVIEW_PERIOD,      "Still in review");

        // pay patient: researcher deposit + stake
        stablecoin.transfer(r.patient, r.amount + r.patientStake);

        r.status = Status.Completed;
        emit RequestAutoCompleted(id);

        // reward: reduce stake pct
        uint256 newPct = _getStakePct(r.patient);
        if (newPct > BASE_STAKE_PCT) {
            newPct = newPct - REDUCTION_STEP;
            if (newPct < BASE_STAKE_PCT) newPct = BASE_STAKE_PCT;
            stakePct[r.patient] = newPct;
            emit StakePctUpdated(r.patient, newPct);
        }
    }

    /// Researcher flags dispute within window
    function flagDispute(uint256 id) external {
        Request storage r = requests[id];
        require(msg.sender == r.researcher,                          "Only researcher");
        require(r.status == Status.Fulfilled,                        "Not fulfill'd");
        require(block.timestamp < r.createdAt + REVIEW_PERIOD,      "Window over");
        r.status = Status.Disputed;
        emit DisputeFlagged(id);
    }

    /// Arbitrator resolves flagged dispute
    function resolveDispute(uint256 id, bool researcherWins) external {
        require(msg.sender == arbitrator,                            "Only arbitrator");
        Request storage r = requests[id];
        require(r.status == Status.Disputed,                         "Not disputed");

        if (researcherWins) {
            // researcher gets both his deposit + patient stake
            stablecoin.transfer(r.researcher, r.amount + r.patientStake);
        } else {
            // patient gets deposit + stake
            stablecoin.transfer(r.patient, r.amount + r.patientStake);
        }

        r.status = Status.Resolved;
        r.insurerDecision = researcherWins;
        emit DisputeResolved(id, researcherWins);

        // reputation update
        uint256 newPct = _getStakePct(r.patient);
        if (!researcherWins) {
            // reward patient: lower stake pct
            if (newPct > BASE_STAKE_PCT) {
                newPct = newPct - REDUCTION_STEP;
                if (newPct < BASE_STAKE_PCT) newPct = BASE_STAKE_PCT;
            }
        } else {
            // penalize patient
            newPct = newPct + PENALTY_STEP;
        }
        stakePct[r.patient] = newPct;
        emit StakePctUpdated(r.patient, newPct);
    }

    /// Expose for tests/UI
    function getPatientPct(address p) external view returns (uint256) {
        return _getStakePct(p);
    }
}
