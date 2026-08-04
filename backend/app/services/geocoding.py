"""
Geocoding providers used to resolve user-supplied place names to coordinates.

All providers are thin adapters over `geopy`, so switching between them only
changes which class the factory returns. The rest of the pipeline consumes
coordinates rather than address strings, which keeps the routing backend free
to be any engine that speaks lat/lon.

Accuracy note: OpenStreetMap-backed geocoders match on structured OSM tags
rather than a query log, so a bare landmark name is often ambiguous worldwide
("Big Ben" alone resolves to a hill in Australia). Passing an `area` such as
"London" resolves this — see `build_queries`.
"""

import os
import re
from dataclasses import dataclass
from typing import Any, Protocol

# geopy ships no type information, so everything it hands back is Any.
from geopy.extra.rate_limiter import RateLimiter  # type: ignore[import-untyped]
from geopy.geocoders import (  # type: ignore[import-untyped]
    GoogleV3,
    Nominatim,
    Photon,
)

DEFAULT_PROVIDER: str = "photon"
DEFAULT_USER_AGENT: str = "travel-planner"
DEFAULT_MIN_DELAY_SECONDS: float = 1.0
DEFAULT_TIMEOUT_SECONDS: int = 10

_PARENTHETICAL = re.compile(r"\(([^)]*)\)")


@dataclass(frozen=True)
class Place:
    """A place name resolved to coordinates by a geocoding provider."""

    query: str  # what the user originally typed
    display_name: str  # normalized name returned by the provider
    lat: float
    lon: float

    @property
    def coords(self) -> tuple[float, float]:
        """Return the position as a (latitude, longitude) pair.

        Returns
        -------
        tuple[float, float]
            Latitude then longitude, in decimal degrees — the order geopy and
            both matrix providers expect.
        """
        return (self.lat, self.lon)

    def __str__(self) -> str:
        """Render the place as the provider's normalized name.

        Returns
        -------
        str
            `display_name`, not the original `query`.
        """
        return self.display_name


def build_queries(place: str, area: str | None = None) -> list[str]:
    """
    Expand a raw place name into query variants, best candidate first.

    Parenthesised text derails OSM geocoders badly enough to be worth handling
    explicitly: "Big Ben (Elizabeth Tower)" returns a replica tower in Cambodia
    on both Photon and Nominatim, while "Big Ben" and "Elizabeth Tower" each
    resolve correctly. So the stripped form is tried before the literal one.

    Parameters
    ----------
    place : str
        Raw place name as typed by the user.
    area : str | None, optional
        City or region appended to each variant to disambiguate the name
        globally, by default None. When given, every area-qualified variant
        is tried before every bare one.

    Returns
    -------
    list[str]
        Query variants in priority order, duplicates removed: the text
        outside any parentheses first, then each parenthesised fragment, then
        the string exactly as typed.
    """
    place = place.strip()
    variants: list[str] = []

    outside = _PARENTHETICAL.sub(" ", place)
    outside = re.sub(r"\s+", " ", outside).strip(" ,")
    inside = [m.strip() for m in _PARENTHETICAL.findall(place) if m.strip()]

    if outside:
        variants.append(outside)
    variants.extend(inside)
    variants.append(place)

    if area:
        area = area.strip()
        variants = [f"{v}, {area}" for v in variants] + variants

    return list(dict.fromkeys(variants))


class GeocodingProvider(Protocol):
    """Resolves a free-text place name, or returns None if nothing matches."""

    name: str

    def geocode(self, place: str, area: str | None = None) -> Place | None:
        """Resolve a place name to coordinates.

        Implementations perform network I/O and may sleep to honour a rate
        limit, so callers on the event loop must go through
        `asyncio.to_thread`.

        Parameters
        ----------
        place : str
            Free-text place name as typed by the user.
        area : str | None, optional
            City or region used to disambiguate the name, by default None.

        Returns
        -------
        Place | None
            The resolved place, or None if no variant of the name matched.
        """
        ...


class _GeopyProvider:
    """
    Shared adapter for geopy geocoders.

    Public OSM endpoints ask callers to stay under one request per second, so
    every lookup goes through a RateLimiter. Self-hosted instances have no such
    limit: set GEOCODER_MIN_DELAY=0.
    """

    name = "geopy"

    def __init__(
        self, geolocator: Any, min_delay_seconds: float = DEFAULT_MIN_DELAY_SECONDS
    ) -> None:
        """Wrap a geopy geocoder in a rate limiter.

        Parameters
        ----------
        geolocator : Any
            A geopy `Geocoder`. Untyped upstream; only its `.geocode` method
            is used.
        min_delay_seconds : float, optional
            Minimum seconds between two requests, enforced by sleeping, by
            default DEFAULT_MIN_DELAY_SECONDS (1.0). Pass 0 for a self-hosted
            instance.
        """
        self._geolocator = geolocator
        self._geocode = RateLimiter(
            geolocator.geocode,
            min_delay_seconds=min_delay_seconds,
            max_retries=2,
            error_wait_seconds=5.0,
            swallow_exceptions=False,
        )

    def geocode(self, place: str, area: str | None = None) -> Place | None:
        """Try each query variant in turn and keep the first match.

        Blocks: every attempt is an HTTP request, and the rate limiter sleeps
        between them, so a name with several variants can take seconds.

        Parameters
        ----------
        place : str
            Free-text place name as typed by the user.
        area : str | None, optional
            City or region used to disambiguate the name, by default None.

        Returns
        -------
        Place | None
            The first match, with `query` set to the name as originally
            given and `display_name` to the provider's normalized address.
            None if no variant matched.
        """
        for query in build_queries(place, area):
            location = self._geocode(
                query, exactly_one=True, timeout=DEFAULT_TIMEOUT_SECONDS
            )
            if location is not None:
                return Place(
                    query=place,
                    display_name=location.address,
                    lat=location.latitude,
                    lon=location.longitude,
                )
        return None


class PhotonGeocoder(_GeopyProvider):
    """
    Photon (OpenStreetMap data, by Komoot).

    Default provider: it ships a prebuilt search index, so self-hosting is a
    single service with no database import, and it resolved every landmark in
    our test set when given an `area`.
    """

    name = "photon"

    def __init__(
        self,
        domain: str = "photon.komoot.io",
        scheme: str | None = None,
        user_agent: str = DEFAULT_USER_AGENT,
        min_delay_seconds: float = DEFAULT_MIN_DELAY_SECONDS,
    ):
        """Build a Photon geocoder.

        Parameters
        ----------
        domain : str, optional
            Host of the Photon instance, by default 'photon.komoot.io'. Use
            e.g. 'localhost:2322' to point at a self-hosted one.
        scheme : str | None, optional
            'http' or 'https', by default None, which picks the scheme from
            the domain: plain HTTP for local hosts, HTTPS otherwise.
        user_agent : str, optional
            Identifies the app to public OSM endpoints, by default
            DEFAULT_USER_AGENT.
        min_delay_seconds : float, optional
            Minimum seconds between requests, by default 1.0.
        """
        super().__init__(
            Photon(
                domain=domain,
                scheme=scheme or _scheme_for(domain),
                user_agent=user_agent,
            ),
            min_delay_seconds,
        )


class NominatimGeocoder(_GeopyProvider):
    """
    Nominatim (OpenStreetMap data).

    Comparable accuracy to Photon, but self-hosting needs PostgreSQL + PostGIS
    and a full OSM import. The public endpoint forbids bulk querying.
    """

    name = "nominatim"

    def __init__(
        self,
        domain: str = "nominatim.openstreetmap.org",
        scheme: str | None = None,
        user_agent: str = DEFAULT_USER_AGENT,
        min_delay_seconds: float = DEFAULT_MIN_DELAY_SECONDS,
    ):
        """Build a Nominatim geocoder.

        Parameters
        ----------
        domain : str, optional
            Host of the Nominatim instance, by default
            'nominatim.openstreetmap.org'.
        scheme : str | None, optional
            'http' or 'https', by default None, which picks the scheme from
            the domain: plain HTTP for local hosts, HTTPS otherwise.
        user_agent : str, optional
            Identifies the app to public OSM endpoints, by default
            DEFAULT_USER_AGENT. The public instance requires a real one.
        min_delay_seconds : float, optional
            Minimum seconds between requests, by default 1.0, which is what
            the public instance's usage policy asks for.
        """
        super().__init__(
            Nominatim(
                domain=domain,
                scheme=scheme or _scheme_for(domain),
                user_agent=user_agent,
            ),
            min_delay_seconds,
        )


class GoogleGeocoder(_GeopyProvider):
    """Google Geocoding API. Kept for comparison; requires a billable API key."""

    name = "google"

    def __init__(self, api_key: str | None = None, min_delay_seconds: float = 0.0):
        """Build a Google geocoder.

        Parameters
        ----------
        api_key : str | None, optional
            Billable Google API key, by default None, in which case the
            GCP_API_KEY environment variable is used.
        min_delay_seconds : float, optional
            Minimum seconds between requests, by default 0.0, i.e. no
            throttling — unlike the two OSM-backed providers.

        Raises
        ------
        ValueError
            If no key is given and GCP_API_KEY is unset or empty.
        """
        api_key = api_key or os.getenv("GCP_API_KEY")
        if not api_key:
            raise ValueError("Google geocoding requires an API key (set GCP_API_KEY)")
        super().__init__(GoogleV3(api_key=api_key), min_delay_seconds)


class ChainedGeocoder:
    """Tries each provider in order and returns the first match."""

    name = "chained"

    def __init__(self, providers: list[GeocodingProvider]):
        """Chain several providers into one.

        Parameters
        ----------
        providers : list[GeocodingProvider]
            Providers to consult, in the order they should be tried. Their
            names are joined with '+' to form this instance's `name`.

        Raises
        ------
        ValueError
            If the list is empty.
        """
        if not providers:
            raise ValueError("ChainedGeocoder needs at least one provider")
        self._providers = providers
        self.name = "+".join(p.name for p in providers)

    def geocode(self, place: str, area: str | None = None) -> Place | None:
        """Ask each provider in turn and return the first match.

        A provider that raises is skipped rather than aborting the chain, but
        the last such exception is re-raised if no provider produced a match.
        A clean "not found" from every provider is not an error.

        Blocks: one full lookup per provider, each with its own rate limiter.

        Parameters
        ----------
        place : str
            Free-text place name as typed by the user.
        area : str | None, optional
            City or region used to disambiguate the name, by default None.

        Returns
        -------
        Place | None
            The first match found, or None if every provider returned no
            match without raising.
        """
        last_error: Exception | None = None
        for provider in self._providers:
            try:
                resolved = provider.geocode(place, area)
                if resolved is not None:
                    return resolved
            except Exception as e:  # noqa: BLE001 - fall through to the next provider
                last_error = e
        if last_error is not None:
            raise last_error
        return None


def _scheme_for(domain: str) -> str:
    """Choose the URL scheme to use for a geocoder host.

    Self-hosted instances are typically plain HTTP on localhost.

    Parameters
    ----------
    domain : str
        Host, optionally with a port, e.g. 'localhost:2322'.

    Returns
    -------
    str
        'http' for a known local or container hostname, 'https' otherwise.
    """
    host = domain.split(":")[0]
    return (
        "http" if host in ("localhost", "127.0.0.1", "photon", "nominatim") else "https"
    )


def get_geocoder(provider: str | None = None) -> GeocodingProvider:
    """
    Build a geocoder from configuration.

    Environment:
        GEOCODER            provider name, or a '+'-separated chain
                            (photon | nominatim | google), default 'photon'
        GEOCODER_DOMAIN     host of a self-hosted instance, e.g. 'localhost:2322'
        GEOCODER_USER_AGENT identifies the app to public OSM endpoints
        GEOCODER_MIN_DELAY  seconds between requests, default 1.0 (use 0 when
                            self-hosting)

    Parameters
    ----------
    provider : str | None, optional
        Provider name, or a '+'-separated chain, overriding the GEOCODER
        environment variable, by default None.

    Returns
    -------
    GeocodingProvider
        A single provider, or a ChainedGeocoder when several are named.
        GEOCODER_DOMAIN is ignored for a chain, since one host cannot serve
        several providers.

    Raises
    ------
    ValueError
        If the setting is present but names no provider, or names one that
        does not exist.
    """
    provider = (provider or os.getenv("GEOCODER") or DEFAULT_PROVIDER).lower()
    user_agent = os.getenv("GEOCODER_USER_AGENT", DEFAULT_USER_AGENT)
    min_delay = float(os.getenv("GEOCODER_MIN_DELAY", DEFAULT_MIN_DELAY_SECONDS))
    domain = os.getenv("GEOCODER_DOMAIN")

    names = [name.strip() for name in provider.split("+") if name.strip()]
    if not names:
        raise ValueError("GEOCODER is set but empty")
    if len(names) > 1:
        return ChainedGeocoder(
            [_build_one(name, user_agent, min_delay, None) for name in names]
        )
    return _build_one(names[0], user_agent, min_delay, domain)


def _build_one(
    name: str, user_agent: str, min_delay: float, domain: str | None
) -> GeocodingProvider:
    """Instantiate a single provider by name.

    Parameters
    ----------
    name : str
        Lowercased provider name: 'photon', 'nominatim' or 'google'.
    user_agent : str
        Identifies the app to public OSM endpoints. Ignored by 'google',
        which authenticates with a key instead.
    min_delay : float
        Minimum seconds between requests. Ignored by 'google'.
    domain : str | None
        Host of a self-hosted instance, or None to use the provider's public
        default. Ignored by 'google'.

    Returns
    -------
    GeocodingProvider
        A newly constructed provider.

    Raises
    ------
    ValueError
        If `name` is not one of the three known providers.
    """
    if name == "photon":
        kwargs = {"domain": domain} if domain else {}
        return PhotonGeocoder(
            user_agent=user_agent, min_delay_seconds=min_delay, **kwargs
        )
    if name == "nominatim":
        kwargs = {"domain": domain} if domain else {}
        return NominatimGeocoder(
            user_agent=user_agent, min_delay_seconds=min_delay, **kwargs
        )
    if name == "google":
        return GoogleGeocoder()

    raise ValueError(
        f"Unknown geocoding provider '{name}'. "
        f"Expected one of: photon, nominatim, google."
    )
