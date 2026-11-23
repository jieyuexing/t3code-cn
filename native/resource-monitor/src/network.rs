use serde::Serialize;
use std::net::IpAddr;
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{IpNetwork, Networks};

// Effect's NonNegativeInt enforces IEEE-754 safe integers; clamp bogus kernel u64::MAX counters.
const MAX_SAFE_JS_INTEGER: u64 = (1_u64 << 53) - 1;
const BOGUS_COUNTER_THRESHOLD: u64 = 1_u64 << 60;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InterfaceSample {
    pub name: String,
    pub ips: Vec<IpAddr>,
    pub total_received: u64,
    pub total_transmitted: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostNetworkTotals {
    pub received_bytes: u64,
    pub transmitted_bytes: u64,
    pub interface_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostNetworkEvent<'a> {
    pub version: u32,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub request_id: &'a str,
    pub sampled_at_unix_ms: u64,
    #[serde(flatten)]
    pub totals: HostNetworkTotals,
}

pub struct NetworkCollector {
    networks: Networks,
}

impl NetworkCollector {
    pub fn new() -> Self {
        Self {
            networks: Networks::new(),
        }
    }

    pub fn read_event<'a>(&mut self, version: u32, request_id: &'a str) -> HostNetworkEvent<'a> {
        self.networks.refresh(true);
        let samples = self
            .networks
            .list()
            .iter()
            .map(|(name, data)| InterfaceSample {
                name: name.clone(),
                ips: ip_addrs(data.ip_networks()),
                total_received: data.total_received(),
                total_transmitted: data.total_transmitted(),
            })
            .collect::<Vec<_>>();
        let totals = aggregate_non_loopback(&samples);
        HostNetworkEvent {
            version,
            event_type: "hostNetwork",
            request_id,
            sampled_at_unix_ms: unix_time_ms(),
            totals,
        }
    }
}

fn ip_addrs(networks: &[IpNetwork]) -> Vec<IpAddr> {
    networks.iter().map(|network| network.addr).collect()
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(MAX_SAFE_JS_INTEGER)
        .min(MAX_SAFE_JS_INTEGER)
}

pub(crate) fn is_loopback_interface(name: &str, ips: &[IpAddr]) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower == "lo" || lower.contains("loopback") {
        return true;
    }
    if let Some(suffix) = lower.strip_prefix("lo")
        && !suffix.is_empty()
        && suffix.bytes().all(|byte| byte.is_ascii_digit())
    {
        return true;
    }
    ips.iter().any(IpAddr::is_loopback)
}

pub(crate) fn aggregate_non_loopback(interfaces: &[InterfaceSample]) -> HostNetworkTotals {
    let mut received_bytes = 0_u64;
    let mut transmitted_bytes = 0_u64;
    let mut interface_count = 0_usize;

    for sample in interfaces {
        if is_loopback_interface(&sample.name, &sample.ips) {
            continue;
        }
        interface_count = interface_count.saturating_add(1);
        if sample.total_received < BOGUS_COUNTER_THRESHOLD {
            received_bytes = received_bytes.saturating_add(sample.total_received);
        }
        if sample.total_transmitted < BOGUS_COUNTER_THRESHOLD {
            transmitted_bytes = transmitted_bytes.saturating_add(sample.total_transmitted);
        }
    }

    let unavailable_reason =
        (interface_count == 0).then(|| "No non-loopback network interfaces found.".to_owned());

    HostNetworkTotals {
        received_bytes: received_bytes.min(MAX_SAFE_JS_INTEGER),
        transmitted_bytes: transmitted_bytes.min(MAX_SAFE_JS_INTEGER),
        interface_count,
        unavailable_reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn excludes_loopback_by_name_and_ip_and_sums_physical_and_tunnel_interfaces() {
        let interfaces = vec![
            InterfaceSample {
                name: "lo0".into(),
                ips: vec![
                    IpAddr::V4(Ipv4Addr::LOCALHOST),
                    IpAddr::V6(Ipv6Addr::LOCALHOST),
                    IpAddr::V6("fe80::1".parse().expect("link local")),
                ],
                total_received: 99_000_000,
                total_transmitted: 99_000_000,
            },
            InterfaceSample {
                name: "lo".into(),
                ips: Vec::new(),
                total_received: 50_000,
                total_transmitted: 50_000,
            },
            InterfaceSample {
                name: "custom0".into(),
                ips: vec![IpAddr::V4(Ipv4Addr::new(127, 0, 1, 1))],
                total_received: 10_000,
                total_transmitted: 10_000,
            },
            InterfaceSample {
                name: "en0".into(),
                ips: vec![IpAddr::V4(Ipv4Addr::new(192, 168, 31, 172))],
                total_received: 4_000,
                total_transmitted: 1_500,
            },
            InterfaceSample {
                name: "utun2".into(),
                ips: vec![IpAddr::V6("fe80::ce81:b1c".parse().expect("utun ip"))],
                total_received: 600,
                total_transmitted: 500,
            },
        ];

        assert_eq!(
            aggregate_non_loopback(&interfaces),
            HostNetworkTotals {
                received_bytes: 4_600,
                transmitted_bytes: 2_000,
                interface_count: 2,
                unavailable_reason: None,
            }
        );
    }

    #[test]
    fn reports_unavailable_when_no_non_loopback_interfaces_exist() {
        let interfaces = vec![InterfaceSample {
            name: "lo0".into(),
            ips: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
            total_received: 1_024,
            total_transmitted: 1_024,
        }];
        let totals = aggregate_non_loopback(&interfaces);
        assert_eq!(totals.interface_count, 0);
        assert!(totals.unavailable_reason.is_some());
    }

    #[test]
    fn skips_bogus_u64_max_counters_and_clamps_to_safe_integer() {
        let interfaces = vec![
            InterfaceSample {
                name: "dummy0".into(),
                ips: Vec::new(),
                total_received: u64::MAX,
                total_transmitted: u64::MAX,
            },
            InterfaceSample {
                name: "eth0".into(),
                ips: vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2))],
                total_received: MAX_SAFE_JS_INTEGER + 500,
                total_transmitted: 2_048,
            },
        ];
        assert_eq!(
            aggregate_non_loopback(&interfaces),
            HostNetworkTotals {
                received_bytes: MAX_SAFE_JS_INTEGER,
                transmitted_bytes: 2_048,
                interface_count: 2,
                unavailable_reason: None,
            }
        );
    }

    #[test]
    fn reads_live_host_network_without_exceeding_safe_integers() {
        let mut collector = NetworkCollector::new();
        let event = collector.read_event(3, "net-live");
        assert_eq!(event.event_type, "hostNetwork");
        assert!(event.totals.received_bytes <= MAX_SAFE_JS_INTEGER);
        assert!(event.totals.transmitted_bytes <= MAX_SAFE_JS_INTEGER);
        assert!(event.totals.interface_count > 0 || event.totals.unavailable_reason.is_some());
    }
}
