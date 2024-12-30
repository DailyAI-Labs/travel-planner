import React, { useState, useEffect } from "react";
import { GoogleMap, LoadScript, Marker, Autocomplete } from "@react-google-maps/api";
import { useRef } from "react";

// Set the map container style
const mapContainerStyle = {
  width: "100%",
  height: "500px",
};

const Map = ({ onPlaceSelect }) => {
  const [currentLocation, setCurrentLocation] = useState(null);
  const [places, setPlaces] = useState([]);
  const autocompleteRef = useRef(null);

  // Get current location
  useEffect(() => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition((position) => {
        setCurrentLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      });
    }
  }, []);

  // When a place is selected from the autocomplete search
  const handlePlaceSelect = () => {
    const place = autocompleteRef.current.getPlace();
    if (place.geometry) {
      const newPlace = {
        name: place.name,
        lat: place.geometry.location.lat(),
        lng: place.geometry.location.lng(),
      };
      setPlaces((prevPlaces) => [...prevPlaces, newPlace]);
      onPlaceSelect(newPlace);
    }
  };

  return (
    <LoadScript googleMapsApiKey="AIzaSyC_1x_fVTBA_5THnpXmFtcNTWuuVS5KsTg" libraries={["places"]}>
      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={currentLocation || { lat: 40.7128, lng: -74.0060 }} // Default center (New York)
        zoom={14}
      >
        {currentLocation && <Marker position={currentLocation} />}
        {places.map((place, index) => (
          <Marker key={index} position={{ lat: place.lat, lng: place.lng }} />
        ))}
        <Autocomplete
          onLoad={(autocomplete) => (autocompleteRef.current = autocomplete)}
          onPlaceChanged={handlePlaceSelect}
        >
          <input
            type="text"
            placeholder="Search for places..."
            style={{
              position: "absolute",
              top: "10px",
              left: "50%",
              transform: "translateX(-50%)",
              padding: "10px",
              fontSize: "16px",
              width: "300px",
            }}
          />
        </Autocomplete>
      </GoogleMap>
    </LoadScript>
  );
};

export default Map;
