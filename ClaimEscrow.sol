// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IERC20.sol";
import "./DoctorRegistry.sol";
import "./AppointmentManager.sol";
import "./InsuranceRegistry.sol";
import "./InsurancePool.sol";

contract ClaimEscrow {
    IERC20             public immutable stablecoin;
    DoctorRegistry     public immutable doctors;
    AppointmentManager public immutable appts;
    InsuranceRegistry  public immutable insurance;
    InsurancePool      public immutable pool;

    uint256 public constant BASE_STAKE_PCT           = 50;
    uint256 public constant MIN_STAKE_PCT            = 5;
    uint256 public constant MAX_STAKE_PCT            = 100;
    uint256 public constant REDUCTION_STEP_PCT       = 5;
    uint256 public constant PATIENT_PENALTY_STEP_PCT = 20;
    uint256 public constant DOCTOR_PENALTY_STEP_PCT  = 10;
    uint256 public constant REVIEW_PERIOD            = 30 days;

    enum Status { Pending, InitialReleased, Completed, Disputed }

    struct Claim {
        address patient;
        address doctor;
        address insurer;
        uint256 amount;
        uint256 patientStake;
        uint256 doctorStake;
        uint256 createdAt;
        uint256 reviewWindow;
        Status  status;
    }

    Claim[] public claims;
    mapping(address => uint256) private stakePctPatient;
    mapping(address => uint256) private stakePctDoctor;

    event ClaimInitiated(uint256 indexed id, address patient, address doctor, uint256 amount);
    event InitialReleased(uint256 indexed id);
    event ClaimCompleted(uint256 indexed id);
    event StakesPenalized(uint256 indexed id);
    event StakePctUpdated(address indexed who, bool isDoctor, uint256 newPct);

    constructor(
        address _stablecoin,
        address _doctorRegistry,
        address _apptMgr,
        address _insuranceRegistry,
        address _pool
    ) {
        stablecoin = IERC20(_stablecoin);
        doctors    = DoctorRegistry(_doctorRegistry);
        appts      = AppointmentManager(_apptMgr);
        insurance  = InsuranceRegistry(_insuranceRegistry);
        pool       = InsurancePool(_pool);
    }

    function _getPatientPct(address p) internal view returns (uint256) {
        uint256 v = stakePctPatient[p];
        return v == 0 ? BASE_STAKE_PCT : v;
    }

    function _getDoctorPct(address d) internal view returns (uint256) {
        uint256 v = stakePctDoctor[d];
        return v == 0 ? BASE_STAKE_PCT : v;
    }

    function initiateClaim(
        address doctor,
        uint256 amount,
        bool emergency
    ) external {
        require(doctors.isDoctor(doctor),               "Not a doctor");
        require(appts.isAuthorized(msg.sender, doctor), "No OP auth");
        (address insurer, ) = insurance.getPolicy(msg.sender);
        require(insurer != address(0),                  "No insurance");
        require(pool.hasCapacity(amount),               "Insufficient reserve");

        uint256 psPct = _getPatientPct(msg.sender);
        uint256 dsPct = _getDoctorPct(doctor);
        uint256 ps    = amount * psPct / 100;
        uint256 ds    = amount * dsPct / 100;

        // collect stakes + deposit
        stablecoin.transferFrom(msg.sender, address(this), ps);
        stablecoin.transferFrom(doctor,      address(this), ds);
        stablecoin.transferFrom(insurer,     address(this), amount);

        uint256 window = emergency ? 1 days : REVIEW_PERIOD;
        claims.push(Claim({
            patient:      msg.sender,
            doctor:       doctor,
            insurer:      insurer,
            amount:       amount,
            patientStake: ps,
            doctorStake:  ds,
            createdAt:    block.timestamp,
            reviewWindow: window,
            status:       Status.Pending
        }));

        emit ClaimInitiated(claims.length - 1, msg.sender, doctor, amount);
    }

    function releaseInitial(uint256 id) external {
        Claim storage c = claims[id];
        require(c.status == Status.Pending, "Wrong status");

        // pay the doctor directly from escrow (insurer's deposit remains here)
        (, uint256 covPct) = insurance.getPolicy(c.patient);
        uint256 toPay = c.amount * covPct / 100;
        stablecoin.transfer(c.doctor, toPay);

        c.status = Status.InitialReleased;
        emit InitialReleased(id);
    }

    function completeClaim(uint256 id) external {
        Claim storage c = claims[id];
        require(c.status == Status.InitialReleased,               "Not released");
        require(block.timestamp >= c.createdAt + c.reviewWindow, "Still in review");

        // refund stakes only (insurer deposit already paid)
        stablecoin.transfer(c.patient, c.patientStake);
        stablecoin.transfer(c.doctor,  c.doctorStake);

        c.status = Status.Completed;
        emit ClaimCompleted(id);

        // adjust reputations
        uint256 newPatPct = _getPatientPct(c.patient);
        if (newPatPct > MIN_STAKE_PCT) {
            newPatPct -= REDUCTION_STEP_PCT;
            stakePctPatient[c.patient] = newPatPct;
            emit StakePctUpdated(c.patient, false, newPatPct);
        }
        uint256 newDocPct = _getDoctorPct(c.doctor);
        if (newDocPct > MIN_STAKE_PCT) {
            newDocPct -= REDUCTION_STEP_PCT;
            stakePctDoctor[c.doctor] = newDocPct;
            emit StakePctUpdated(c.doctor, true, newDocPct);
        }
    }

    function disputeClaim(uint256 id) external {
        Claim storage c = claims[id];
        require(c.status == Status.InitialReleased,               "Not released");
        require(block.timestamp < c.createdAt + c.reviewWindow,  "Window over");
        require(msg.sender == c.insurer || msg.sender == c.patient, "No auth");

        // compute slash based on current stakes
        uint256 pctP     = _getPatientPct(c.patient);
        uint256 pctD     = _getDoctorPct(c.doctor);
        uint256 slashAmt = (c.amount * pctP / 100) + (c.amount * pctD / 100);

        stablecoin.transfer(c.insurer, slashAmt);

        c.status = Status.Disputed;
        emit StakesPenalized(id);

        // penalty adjustments
        uint256 patPct = pctP + PATIENT_PENALTY_STEP_PCT;
        if (patPct > MAX_STAKE_PCT) patPct = MAX_STAKE_PCT;
        stakePctPatient[c.patient] = patPct;
        emit StakePctUpdated(c.patient, false, patPct);

        uint256 docPct = pctD + DOCTOR_PENALTY_STEP_PCT;
        if (docPct > MAX_STAKE_PCT) docPct = MAX_STAKE_PCT;
        stakePctDoctor[c.doctor] = docPct;
        emit StakePctUpdated(c.doctor, true, docPct);
    }

    function getPatientPct(address p) external view returns (uint256) {
        return _getPatientPct(p);
    }

    function getDoctorPct(address d) external view returns (uint256) {
        return _getDoctorPct(d);
    }
}
