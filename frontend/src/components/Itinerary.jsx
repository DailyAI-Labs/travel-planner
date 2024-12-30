import React from "react";

const Itinerary = ({ places, onRemovePlace }) => {
  return (
    <div style={{ marginTop: "20px" }}>
      <h2>Your Travel Plan</h2>
      <ul>
        {places.map((place, index) => (
          <li key={index}>
            {place.name}{" "}
            <button onClick={() => onRemovePlace(index)} style={{ marginLeft: "10px" }}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default Itinerary;
