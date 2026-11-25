#!/usr/bin/env bash
# Demo: 1 peer org, 3 peers, 3 Raft orderers, two Fabric CAs.
# Run from ~/Fabric_Master_Setup after both CA containers are healthy.
set -euo pipefail
set +x

ORG_CA_HOST=localhost
ORG_CA_PORT=7054
ORDERER_CA_HOST=localhost
ORDERER_CA_PORT=9054
PEER0_IP=192.168.0.100
PEER1_IP=162.35.183.27
PEER2_IP=13.206.4.29
ORDERER1_IP=192.168.0.100
ORDERER2_IP=162.35.183.27
ORDERER3_IP=13.206.4.29

ORG_DOMAIN=org1.example.com
ORDERER_DOMAIN=example.com
ORG_CA_NAME=ca-org1
ORDERER_CA_NAME=ca-orderer

info() { printf '[INFO] %s\n' "$*"; }
ROOT="$(pwd)"
ORG_ROOT="${ROOT}/organizations/peerOrganizations/${ORG_DOMAIN}"
ORDERER_ROOT="${ROOT}/organizations/ordererOrganizations/${ORDERER_DOMAIN}"
ORG_CA_CERT="${ROOT}/organizations/fabric-ca/org1/ca-cert.pem"
ORDERER_CA_CERT="${ROOT}/organizations/fabric-ca/ordererOrg/ca-cert.pem"
ORG_CA_URL="https://${ORG_CA_HOST}:${ORG_CA_PORT}"
ORDERER_CA_URL="https://${ORDERER_CA_HOST}:${ORDERER_CA_PORT}"

command -v fabric-ca-client >/dev/null || { echo 'fabric-ca-client not found' >&2; exit 1; }
[[ -f "$ORG_CA_CERT" && -f "$ORDERER_CA_CERT" ]] || { echo 'CA root certificate(s) missing' >&2; exit 1; }
[[ -d "${ROOT}/organizations/fabric-ca" ]] || { echo 'Run from Fabric_Master_Setup root' >&2; exit 1; }

# This demo uses the same CA for enrollment and TLS per organization.
# Do not overwrite an existing identity tree: rerunning enrollment against
# existing key material can create inconsistent certificates and private keys.
if [[ -e "$ORG_ROOT" || -e "$ORDERER_ROOT" ]]; then
  echo "Identity output directories already exist; review/back up before rerunning:" >&2
  echo "  $ORG_ROOT" >&2
  echo "  $ORDERER_ROOT" >&2
  exit 1
fi

write_node_ous() {
  local output="$1" cert_basename="$2"
  cat > "$output" <<YAML
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${cert_basename}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${cert_basename}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${cert_basename}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${cert_basename}
    OrganizationalUnitIdentifier: orderer
YAML
}

# Locate the actual CA cert filename created by fabric-ca-client; do not
# hardcode 'localhost-7054-...' since names change with CA hostnames.
admin_ca_cert_name() {
  local msp="$1"
  local files=("${msp}/cacerts/"*.pem)
  [[ ${#files[@]} -eq 1 && -f "${files[0]}" ]] || {
    echo "Expected one CA PEM under ${msp}/cacerts" >&2; return 1;
  }
  basename "${files[0]}"
}

register_identity() {
  local url="$1" caname="$2" tls_cert="$3" name="$4" secret="$5" type="$6"
  fabric-ca-client register -u "$url" --caname "$caname" \
    --id.name "$name" --id.secret "$secret" --id.type "$type" \
    --tls.certfiles "$tls_cert"
}

enroll_msp() {
  local url="$1" caname="$2" tls_cert="$3" name="$4" secret="$5" dest="$6"
  fabric-ca-client enroll -u "https://${name}:${secret}@${url#https://}" \
    --caname "$caname" -M "$dest" --tls.certfiles "$tls_cert"
}

enroll_tls() {
  local url="$1" caname="$2" tls_cert="$3" name="$4" secret="$5" dest="$6" fqdn="$7" ip="$8"
  fabric-ca-client enroll -u "https://${name}:${secret}@${url#https://}" \
    --caname "$caname" -M "$dest" --enrollment.profile tls \
    --csr.hosts "$fqdn" --csr.hosts "$name" --csr.hosts "$ip" \
    --tls.certfiles "$tls_cert"
  cp "${dest}/tlscacerts/"* "${dest}/ca.crt"
  cp "${dest}/signcerts/"* "${dest}/server.crt"
  cp "${dest}/keystore/"* "${dest}/server.key"
}

createOrg1() {
  info 'Enrolling Org1 CA bootstrap admin'
  mkdir -p "$ORG_ROOT"
  export FABRIC_CA_CLIENT_HOME="$ORG_ROOT"
  enroll_msp "$ORG_CA_URL" "$ORG_CA_NAME" "$ORG_CA_CERT" admin adminpw "$ORG_ROOT/msp"
  local ca_file
  ca_file="$(admin_ca_cert_name "$ORG_ROOT/msp")"
  write_node_ous "$ORG_ROOT/msp/config.yaml" "$ca_file"
  mkdir -p "$ORG_ROOT/msp/tlscacerts" "$ORG_ROOT/tlsca" "$ORG_ROOT/ca"
  cp "$ORG_CA_CERT" "$ORG_ROOT/msp/tlscacerts/ca.crt"
  cp "$ORG_CA_CERT" "$ORG_ROOT/tlsca/tlsca.${ORG_DOMAIN}-cert.pem"
  cp "$ORG_CA_CERT" "$ORG_ROOT/ca/ca.${ORG_DOMAIN}-cert.pem"

  local peer ip dest
  for peer in peer0 peer1 peer2; do
    info "Registering $peer"
    register_identity "$ORG_CA_URL" "$ORG_CA_NAME" "$ORG_CA_CERT" "$peer" "${peer}pw" peer
  done
  register_identity "$ORG_CA_URL" "$ORG_CA_NAME" "$ORG_CA_CERT" user1 user1pw client
  register_identity "$ORG_CA_URL" "$ORG_CA_NAME" "$ORG_CA_CERT" org1admin org1adminpw admin

  for peer in peer0 peer1 peer2; do
    case "$peer" in
      peer0) ip="$PEER0_IP" ;;
      peer1) ip="$PEER1_IP" ;;
      peer2) ip="$PEER2_IP" ;;
    esac
    dest="$ORG_ROOT/peers/${peer}.${ORG_DOMAIN}"
    info "Enrolling $peer MSP and TLS (SAN IP: $ip)"
    enroll_msp "$ORG_CA_URL" "$ORG_CA_NAME" "$ORG_CA_CERT" "$peer" "${peer}pw" "$dest/msp"
    cp "$ORG_ROOT/msp/config.yaml" "$dest/msp/config.yaml"
    enroll_tls "$ORG_CA_URL" "$ORG_CA_NAME" "$ORG_CA_CERT" "$peer" "${peer}pw" \
      "$dest/tls" "${peer}.${ORG_DOMAIN}" "$ip"
  done

  info 'Enrolling Org1 user and admin'
  dest="$ORG_ROOT/users/User1@${ORG_DOMAIN}/msp"
  enroll_msp "$ORG_CA_URL" "$ORG_CA_NAME" "$ORG_CA_CERT" user1 user1pw "$dest"
  cp "$ORG_ROOT/msp/config.yaml" "$dest/config.yaml"
  dest="$ORG_ROOT/users/Admin@${ORG_DOMAIN}/msp"
  enroll_msp "$ORG_CA_URL" "$ORG_CA_NAME" "$ORG_CA_CERT" org1admin org1adminpw "$dest"
  cp "$ORG_ROOT/msp/config.yaml" "$dest/config.yaml"
}

createOrderer() {
  info 'Enrolling Orderer CA bootstrap admin'
  mkdir -p "$ORDERER_ROOT"
  export FABRIC_CA_CLIENT_HOME="$ORDERER_ROOT"
  enroll_msp "$ORDERER_CA_URL" "$ORDERER_CA_NAME" "$ORDERER_CA_CERT" admin adminpw "$ORDERER_ROOT/msp"
  local ca_file
  ca_file="$(admin_ca_cert_name "$ORDERER_ROOT/msp")"
  write_node_ous "$ORDERER_ROOT/msp/config.yaml" "$ca_file"
  mkdir -p "$ORDERER_ROOT/msp/tlscacerts" "$ORDERER_ROOT/tlsca" "$ORDERER_ROOT/ca"
  cp "$ORDERER_CA_CERT" "$ORDERER_ROOT/msp/tlscacerts/tlsca.${ORDERER_DOMAIN}-cert.pem"
  cp "$ORDERER_CA_CERT" "$ORDERER_ROOT/tlsca/tlsca.${ORDERER_DOMAIN}-cert.pem"
  cp "$ORDERER_CA_CERT" "$ORDERER_ROOT/ca/ca.${ORDERER_DOMAIN}-cert.pem"

  local orderer ip dest
  for orderer in orderer orderer2 orderer3; do
    case "$orderer" in
      orderer) ip="$ORDERER1_IP" ;;
      orderer2) ip="$ORDERER2_IP" ;;
      orderer3) ip="$ORDERER3_IP" ;;
    esac
    info "Registering and enrolling $orderer (SAN IP: $ip)"
    register_identity "$ORDERER_CA_URL" "$ORDERER_CA_NAME" "$ORDERER_CA_CERT" \
      "$orderer" "${orderer}pw" orderer
    dest="$ORDERER_ROOT/orderers/${orderer}.${ORDERER_DOMAIN}"
    enroll_msp "$ORDERER_CA_URL" "$ORDERER_CA_NAME" "$ORDERER_CA_CERT" \
      "$orderer" "${orderer}pw" "$dest/msp"
    cp "$ORDERER_ROOT/msp/config.yaml" "$dest/msp/config.yaml"
    mv "$dest/msp/signcerts/cert.pem" "$dest/msp/signcerts/${orderer}.${ORDERER_DOMAIN}-cert.pem"
    enroll_tls "$ORDERER_CA_URL" "$ORDERER_CA_NAME" "$ORDERER_CA_CERT" \
      "$orderer" "${orderer}pw" "$dest/tls" "${orderer}.${ORDERER_DOMAIN}" "$ip"
    mkdir -p "$dest/msp/tlscacerts"
    cp "$dest/tls/ca.crt" "$dest/msp/tlscacerts/tlsca.${ORDERER_DOMAIN}-cert.pem"
  done

  info 'Registering and enrolling Orderer administrator'
  register_identity "$ORDERER_CA_URL" "$ORDERER_CA_NAME" "$ORDERER_CA_CERT" \
    ordererAdmin ordererAdminpw admin
  dest="$ORDERER_ROOT/users/Admin@${ORDERER_DOMAIN}/msp"
  enroll_msp "$ORDERER_CA_URL" "$ORDERER_CA_NAME" "$ORDERER_CA_CERT" \
    ordererAdmin ordererAdminpw "$dest"
  cp "$ORDERER_ROOT/msp/config.yaml" "$dest/config.yaml"
}

createOrg1
createOrderer
info 'All demo identities enrolled successfully.'
