import React, { useState } from "react";
import Map from "./Map";
import Itinerary from "./Itinerary";

const App = () => {
  const [places, setPlaces] = useState([]);

  const handlePlaceSelect = (newPlace) => {
    // Add new place to the list
    setPlaces((prevPlaces) => [...prevPlaces, newPlace]);
  };

  const handleRemovePlace = (index) => {
    // Remove place from the list
    setPlaces((prevPlaces) => prevPlaces.filter((_, i) => i !== index));
  };

  return (
    <div>
      <h1>dAI: Daily High</h1>
      <Map onPlaceSelect={handlePlaceSelect} />
      <Itinerary places={places} onRemovePlace={handleRemovePlace} />
    </div>
  );
};

export default App;
